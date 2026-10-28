import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getYandexConnectionCredentialsV1, listYandexConnectionMetadataV1 } from '@/modules/fleet-operations/public/v1/yandex-connection-capability'
import { PATCH_DRIVER_TELEGRAM_LINK_COMMAND_V1, RECORD_BOT_USER_PROFILE_COMMAND_V1, RECORD_PENDING_BOT_LINK_REQUEST_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import {
    canonicalTelegramBotConnectionIdV1,
    patchDriverTelegramLinkV1,
    prepareDriverTelegramConversationAuthorityV1,
    recordBotUserProfileV1,
    recordPendingBotLinkRequestV1,
    type PreparedDriverTelegramConversationAuthorityV1,
} from '@/modules/telegram-channel/public/v1'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import { getConfirmedContactForDriverClusterV1 } from '@/modules/contacts/public/v1/driver-person-confirmation'
import {
    APPEND_SYSTEM_NOTIFICATION_V1,
    MARK_REQUIRES_RESPONSE_V1,
    SEND_MESSAGE_COMMAND_V1,
    UPDATE_CONVERSATION_COMMAND_V1,
} from '@/contracts/messaging/v1'
import { sendMessageV1, updateConversationV1 } from '@/modules/messaging/public/v1'
import { MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1, RECORD_DRIVER_ACTION_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import {
    compensationPilotOrderCheckV1,
    compensationPilotRefreshV1,
    compensationPilotSectionV1,
    compensationPilotSubmitV1,
    mirrorDriverActionResultV1,
    recordDriverActionV1,
} from '@/modules/fleet-operations/public/v1'

export async function POST(request: Request) {
    try {
        const signature = request.headers.get('x-bot-signature')
        if (signature !== process.env.BOT_CRM_SECRET) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const { action, payload } = body

        switch (action) {
            case 'sync_user':
                return await handleSyncUser(payload)
            case 'change_limit':
                return await handleChangeLimit(payload)
            case 'check_link':
                return await handleCheckLink(payload)
            case 'search_car_by_plate':
                return await handleSearchCarByPlate(payload)
            case 'update_driver_car':
                return await handleUpdateDriverCar(payload)
            case 'get_order_price':
                return await handleDriverAction(payload, 'GET_PRICE')
            case 'complete_order':
                return await handleDriverAction(payload, 'COMPLETE_ORDER')
            case 'cancel_order':
                return await handleDriverAction(payload, 'CANCEL_ORDER')
            case 'poll_driver_action':
                return await handlePollDriverAction(payload)
            case 'list_parks':
                return await handleListParks()
            case 'set_active_park':
                return await handleSetActivePark(payload)
            case 'get_park_info':
                return await handleGetParkInfo(payload)
            case 'compensation_section':
                return await handleCompensationSection(payload)
            case 'compensation_submit':
                return await handleCompensationSubmit(payload)
            case 'compensation_order_check':
                return await handleCompensationOrderCheck(payload)
            case 'compensation_refresh':
                return await handleCompensationRefresh(payload)
            default:
                return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
        }
    } catch (err: any) {
        console.error('Webhook error:', err)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

/**
 * The one implementation of current Telegram Driver authority for bot actions.
 * Returns the person proof, or null when the Bot runtime transport, the exact
 * private chat or the confirmed Driver person cannot be proven right now.
 */
async function resolveCurrentBotDriverAuthority(
    payload: unknown,
    input: { driverId: string; telegramId: bigint },
): Promise<PreparedDriverTelegramConversationAuthorityV1 | null> {
    const record = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
    const providerAccountId = typeof record.providerAccountId === 'string'
        ? record.providerAccountId.trim()
        : ''
    const connectionId = typeof record.connectionId === 'string'
        ? record.connectionId.trim()
        : ''
    // Bot RUNTIME authority, proven independently of the person. The request is
    // already authenticated by BOT_CRM_SECRET above. providerAccountId is live
    // provenance reported by the bot process: it is required to be concrete so a
    // caller cannot omit it, but it is never treated as account authority, and it
    // is never compared against stored Chat or identity metadata.
    // See docs/design/provider-account-identity-v1.md.
    if (!providerAccountId || !/^\d+$/.test(providerAccountId) || !connectionId) return null
    try {
        // The claimed transport is proven against the Telegram-owned
        // configuration, never against Chat.metadata.connectionId: a Chat is the
        // shared peer identity and its stored connection may legitimately name
        // the MTProto personal-account transport.
        if (connectionId !== canonicalTelegramBotConnectionIdV1()) {
            throw new Error('TELEGRAM_BOT_CONNECTION_MISMATCH')
        }
        // Independent PERSON/CONVERSATION proof: exact private Chat for this
        // peer, exact Contact, active conflict-free ContactIdentity, and a
        // confirmed main Driver. It names no transport.
        const person = await prepareDriverTelegramConversationAuthorityV1(input)
        if (
            person.target !== input.telegramId.toString()
            || person.driverId !== input.driverId
        ) {
            throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
        }
        return person
    } catch (error: unknown) {
        console.warn(
            '[driver-bot] Current Telegram Driver authority rejected:',
            error instanceof Error ? error.message : String(error),
        )
        return null
    }
}

async function requireCurrentBotDriverAuthority(
    payload: unknown,
    input: { driverId: string; telegramId: bigint },
): Promise<NextResponse | null> {
    if (await resolveCurrentBotDriverAuthority(payload, input)) return null
    return NextResponse.json({
        error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
    }, { status: 409 })
}

/**
 * The Yandex contractor profile id of a Driver row, or null when it has none.
 * yandexDriverId holds a Yandex profile id only on legacy rows: the fleet
 * reconciler stores a park-qualified CRM key there ("park-profile:<digest>",
 * earlier "park:<park>:<profile>") and keeps the real profile id in
 * externalDriverProfileId. A Yandex profile id never contains ':'.
 */
function yandexContractorProfileId(driver: {
    yandexDriverId: string | null
    externalDriverProfileId: string | null
} | null): string | null {
    for (const candidate of [driver?.externalDriverProfileId, driver?.yandexDriverId]) {
        const id = candidate?.trim()
        if (id && !id.includes(':')) return id
    }
    return null
}

const PROFILE_PARK_UNPROVEN_TEXT = 'Ваш профиль в выбранном парке не подтверждён. Выберите парк заново или обратитесь к менеджеру.'

/**
 * The Yandex profile and park a bot action may act on. A profile id means
 * something only in the park of the Driver row it came from, so a selected
 * park that differs from that park is refused rather than guessed, and no
 * default park is ever chosen. A legacy row with no recorded park acts in the
 * park the driver selected, where set_active_park checked the driver's phone.
 */
function driverYandexTarget(driver: {
    yandexDriverId: string | null
    externalDriverProfileId: string | null
    externalParkId: string | null
} | null, selectedParkId: string | null | undefined):
    | { ok: true; profileId: string; parkId: string }
    | { ok: false; reason: 'NO_PROFILE' | 'PARK_UNPROVEN' } {
    const profileId = yandexContractorProfileId(driver)
    if (!profileId) return { ok: false, reason: 'NO_PROFILE' }
    const profilePark = driver?.externalParkId?.trim() || null
    const selected = selectedParkId?.trim() || null
    if (selected && profilePark && selected !== profilePark) return { ok: false, reason: 'PARK_UNPROVEN' }
    const parkId = selected ?? profilePark
    return parkId ? { ok: true, profileId, parkId } : { ok: false, reason: 'PARK_UNPROVEN' }
}

/** The last ten digits of a phone: the only form two phone spellings are compared in. */
function phoneKey(value: unknown): string | null {
    const digits = typeof value === 'string' ? value.replace(/\D/g, '') : ''
    return digits.length >= 10 ? digits.slice(-10) : null
}

/**
 * The single Yandex profile of a park listing whose phone is exactly the
 * driver's, or null: no match and more than one match both pick nothing, so a
 * search never hands a driver's action to someone else's profile.
 */
function uniqueProfileByPhone(profiles: any[], phone: string | null | undefined, eligible: (profile: any) => boolean = () => true): any | null {
    const key = phoneKey(phone)
    if (!key) return null
    const matches = profiles.filter((profile) => eligible(profile)
        && (profile?.driver_profile?.phones || []).some((candidate: unknown) => phoneKey(candidate) === key))
    return matches.length === 1 ? matches[0] : null
}

// Check if a Telegram user is linked to a driver
async function handleCheckLink(payload: any) {
    const deadline = providerDeadline()
    const { telegramId } = payload
    if (!telegramId) {
        return NextResponse.json({ error: 'Missing telegramId' }, { status: 400 })
    }

    const telegramIdBigInt = BigInt(telegramId)
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: telegramIdBigInt }
    })

    if (!mapping || !mapping.driverId) {
        return NextResponse.json({ linked: false })
    }
    const authorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (authorityFailure) return authorityFailure

    let driverName = mapping.username || null
    let carInfo: string | null = null

    // Return cached car label immediately — avoids 9 sequential Yandex API calls
    // which (a) trigger 429 rate-limiting and (b) cost ~5 seconds per check_link.
    // Cache is populated below on first successful lookup.
    // The cache holds only the car of the link row in that row's own recorded
    // park, and is shown only while that park is selected: a lookup that
    // finished after a park switch can then never show one park's car in
    // another. A link row with no recorded park never uses the cache.
    if (mapping.carLabel) {
        let cachedDriver: { fullName: string; externalParkId: string | null } | null | undefined
        try {
            cachedDriver = await prisma.driver.findFirst({
                where: { OR: [{ id: mapping.driverId }, { yandexDriverId: mapping.driverId }] },
                select: { fullName: true, externalParkId: true }
            })
        } catch { /* park unknown: look the car up instead */ }
        const cachePark = cachedDriver?.externalParkId?.trim() || null
        const selectedPark = mapping.activeParkId?.trim() || null
        if (cachePark && (!selectedPark || cachePark === selectedPark)) {
            if (cachedDriver?.fullName) driverName = cachedDriver.fullName
            return NextResponse.json({ linked: true, driverId: mapping.driverId, driverName, carInfo: mapping.carLabel })
        }
    }

    try {
        // Try CRM id first (manually-linked records), then Yandex contractor id
        // (records created by sync_user which stores the Yandex driver_profile.id).
        let driver: BotDriverRow | null = await prisma.driver.findUnique({
            where: { id: mapping.driverId },
            select: BOT_DRIVER_SELECT,
        })
        if (!driver) {
            driver = await prisma.driver.findFirst({
                where: { yandexDriverId: mapping.driverId },
                select: BOT_DRIVER_SELECT,
            })
        }
        // In another park of the same person the car is looked up there and
        // shown, but never cached and never searched for by phone.
        const acting = await botActingDriver(payload, mapping, telegramIdBigInt, driver)
        const ownPark = acting.crossPark === null
        driver = acting.driver
        // Only a link row with a recorded park caches its car: the cache then
        // always belongs to that one park.
        const cacheable = ownPark && !!driver?.externalParkId?.trim()

        const target = driverYandexTarget(driver, mapping.activeParkId)
        if (driver?.fullName) driverName = driver.fullName
        if (!target.ok) {
            console.warn(`[check_link] no Yandex profile in a proven park (${target.reason}), skipping Yandex lookup:`, mapping.driverId)
            return NextResponse.json({ linked: true, driverId: mapping.driverId, driverName, carInfo })
        }
        const yandexContractorId = target.profileId

        const connection = await getYandexConnectionCredentialsV1(undefined, target.parkId)
        if (connection) {
            const headers: Record<string, string> = {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'X-Park-ID': connection.parkId,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json'
            }

            // Use v2 API (same as CRM UI) — reliably returns car_id
            const v2Url = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${yandexContractorId}`
            const v2Res = await fetch(v2Url, { method: 'GET', headers, signal: providerSignal(deadline) })

            if (v2Res.ok) {
                const p = await v2Res.json()
                console.log('[check_link] v2 profile:', JSON.stringify(p).substring(0, 400))

                // Driver name
                const fn = p.person?.full_name || {}
                const parts = [fn.last_name, fn.first_name, fn.middle_name].filter(Boolean)
                if (parts.length > 0) driverName = parts.join(' ')

                // Car info — get car_id from v2, then fetch car details
                const carId = p.car_id
                if (carId) {
                    console.log('[check_link] car_id from v2:', carId)
                    const car = await findCarById(connection, carId, deadline)
                    if (car) {
                        carInfo = `${car.brand || ''} ${car.model || ''} ${car.plate || ''}`.trim()
                        console.log('[check_link] found car:', carInfo)
                        // Cache to DriverTelegram so future check_link calls skip Yandex pagination
                        if (cacheable) {
                            const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
                                driverId: mapping.driverId,
                                telegramId: telegramIdBigInt,
                            })
                            if (mutationAuthorityFailure) return mutationAuthorityFailure
                            await patchDriverTelegramLinkV1({ contract: PATCH_DRIVER_TELEGRAM_LINK_COMMAND_V1, mappingId: mapping.id, patch: { carLabel: carInfo } }).catch(() => {})
                        }
                    }
                }
            } else {
                console.error('[check_link] v2 error:', v2Res.status, await v2Res.text())
                // Fallback: search driver by phone in the active park (driver may have
                // a different contractor_profile_id in this park vs the one stored in CRM).
                if (v2Res.status === 404 && ownPark) {
                    try {
                        const fullDriver = await prisma.driver.findUnique({
                            where: { id: mapping.driverId },
                            select: { phone: true }
                        })
                        const phone = fullDriver?.phone
                        if (phone) {
                            const searchRes = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                                method: 'POST',
                                headers: {
                                    'X-Client-ID': connection.clid,
                                    'X-Api-Key': connection.apiKey,
                                    'Accept-Language': 'ru',
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    query: { park: { id: connection.parkId }, text: phone },
                                    fields: { driver_profile: ['id', 'phones', 'work_status'], car: [], account: [], current_status: [] },
                                    limit: 5, offset: 0
                                }),
                                signal: providerSignal(deadline),
                            })
                            if (searchRes.ok) {
                                const searchData = await searchRes.json()
                                const matched = uniqueProfileByPhone(searchData.driver_profiles || [], phone)
                                if (matched) {
                                    const carId = matched.car?.id
                                    if (carId) {
                                        const car = await findCarById(connection, carId, deadline)
                                        if (car) {
                                            carInfo = `${car.brand || ''} ${car.model || ''} ${car.plate || ''}`.trim()
                                            console.log('[check_link] phone-search fallback car:', carInfo)
                                            if (cacheable) {
                                                const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
                                                    driverId: mapping.driverId,
                                                    telegramId: telegramIdBigInt,
                                                })
                                                if (mutationAuthorityFailure) return mutationAuthorityFailure
                                                await patchDriverTelegramLinkV1({ contract: PATCH_DRIVER_TELEGRAM_LINK_COMMAND_V1, mappingId: mapping.id, patch: { carLabel: carInfo } }).catch(() => {})
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (fbErr: any) {
                        console.error('[check_link] phone-search fallback failed:', fbErr.message)
                    }
                }
            }
        }
    } catch (err: any) {
        console.error('[check_link] Failed to fetch driver/car info:', err.message)
    }

    return NextResponse.json({ linked: true, driverId: mapping.driverId, driverName, carInfo })
}

/** The Driver columns a bot action reads, with the licence cluster one person's parks share. */
const BOT_DRIVER_SELECT = {
    id: true,
    fullName: true,
    phone: true,
    yandexDriverId: true,
    externalDriverProfileId: true,
    externalParkId: true,
    externalPersonKey: true,
    contactId: true,
} as const

type BotDriverRow = {
    id: string
    fullName: string | null
    phone: string | null
    yandexDriverId: string | null
    externalDriverProfileId: string | null
    externalParkId: string | null
    externalPersonKey: string | null
    contactId: string | null
}

/**
 * How long the person proof an action started with may authorize its provider
 * change: shorter than the bot's 15 s wait for an answer, so nothing changes at
 * the provider after the driver has already been told the request failed.
 */
const CROSS_PARK_PROOF_TTL_MS = 12_000

/** A real Yandex contractor profile id, the only form the Fleet API and the scraper act on. */
const YANDEX_PROFILE_ID = /^[a-f0-9]{24,}$/

/** What an action acting in another park of the same person was authorized with. */
type CrossParkProof = {
    anchorDriverId: string
    actingDriverId: string
    profileId: string
    parkId: string
    contactId: string
    clusterKey: string
    provenAt: number
}

/**
 * The Driver row a bot action acts on, fixed once when the action starts.
 *
 * The Telegram link names one Driver row for good, and a park switch never
 * rewrites it. In that row's own park, with no park selected, or for a legacy
 * row with no recorded park, the row acts itself. In another selected park the
 * action may act only on the same person's own Driver row of that park (see
 * proveCrossParkDriver); anything else keeps the link row, which the park guard
 * then refuses exactly as before. The selected park is the one the action read
 * at its start: a later switch never moves a running action.
 */
async function botActingDriver(
    payload: unknown,
    mapping: { driverId: string; activeParkId: string | null },
    telegramId: bigint,
    anchor: BotDriverRow | null,
): Promise<{ driver: BotDriverRow | null; crossPark: CrossParkProof | null }> {
    const selected = mapping.activeParkId?.trim() || null
    const anchorPark = anchor?.externalParkId?.trim() || null
    if (!anchor || !selected || !anchorPark || selected === anchorPark) return { driver: anchor, crossPark: null }
    return await proveCrossParkDriver(payload, mapping.driverId, telegramId, anchor, selected)
        ?? { driver: anchor, crossPark: null }
}

/**
 * The same person's own Driver row in another park, with the proof it rests on.
 *
 * Every part must hold now: the bot authority proves the Contact behind the
 * link; the link row belongs to that Contact; Contacts confirms the link row's
 * licence cluster to that Contact alone; and exactly one non-dismissed row of
 * that cluster is in the park, linked to that Contact, operator-confirmed by
 * the fleet reconciler, with a real Yandex profile id of its own. Only a
 * licence cluster joins parks. No phone, name or first match is involved.
 */
async function proveCrossParkDriver(
    payload: unknown,
    anchorDriverId: string,
    telegramId: bigint,
    anchor: BotDriverRow,
    parkId: string,
): Promise<{ driver: BotDriverRow; crossPark: CrossParkProof } | null> {
    const clusterKey = anchor.externalPersonKey?.trim() || ''
    if (!clusterKey.startsWith('vu:')) return null
    try {
        const authority = await resolveCurrentBotDriverAuthority(payload, { driverId: anchorDriverId, telegramId })
        if (!authority || anchor.contactId !== authority.contactId) return null
        const confirmed = await getConfirmedContactForDriverClusterV1(clusterKey)
        if (!confirmed || confirmed.contactId !== authority.contactId) return null
        const rows = await prisma.driver.findMany({
            where: {
                externalPersonKey: clusterKey,
                externalParkId: parkId,
                contactId: authority.contactId,
                personResolutionStatus: 'operator_confirmed',
                dismissedAt: null,
                id: { not: anchor.id },
            },
            select: BOT_DRIVER_SELECT,
            take: 2,
        })
        if (rows.length !== 1) return null
        const [row] = rows
        const profileId = row.externalDriverProfileId?.trim() || ''
        if (row.externalParkId !== parkId || !YANDEX_PROFILE_ID.test(profileId)) return null
        return {
            driver: row,
            crossPark: {
                anchorDriverId,
                actingDriverId: row.id,
                profileId,
                parkId,
                contactId: authority.contactId,
                clusterKey,
                provenAt: Date.now(),
            },
        }
    } catch (error: unknown) {
        console.warn('[driver-bot] cross-park Driver not proven:', error instanceof Error ? error.message : String(error))
        return null
    }
}

/**
 * Whether the proof an action started with still holds right before it changes
 * something at the provider. It keeps the park and Driver row fixed at the
 * action's start and never reads the selected park again; it refuses a proof
 * older than CROSS_PARK_PROOF_TTL_MS, or one that no longer names the same row,
 * profile, Contact and cluster. The link row is read again as well: its cluster,
 * Contact and park must still be the ones the action started with. An action in
 * the link row's own park has no proof to keep.
 */
async function crossParkProofStillHolds(
    payload: unknown,
    telegramId: bigint,
    anchor: BotDriverRow | null,
    proof: CrossParkProof | null,
): Promise<boolean> {
    if (!proof) return true
    if (!anchor || Date.now() - proof.provenAt > CROSS_PARK_PROOF_TTL_MS) return false
    let current: BotDriverRow | null
    try {
        current = await prisma.driver.findUnique({ where: { id: anchor.id }, select: BOT_DRIVER_SELECT })
    } catch (error: unknown) {
        console.warn('[driver-bot] link row not re-read for the cross-park proof:', error instanceof Error ? error.message : String(error))
        return false
    }
    if (
        !current
        || current.externalPersonKey !== anchor.externalPersonKey
        || current.contactId !== anchor.contactId
        || current.externalParkId !== anchor.externalParkId
    ) return false
    const again = (await proveCrossParkDriver(payload, proof.anchorDriverId, telegramId, current, proof.parkId))?.crossPark
    return !!again
        && again.actingDriverId === proof.actingDriverId
        && again.profileId === proof.profileId
        && again.contactId === proof.contactId
        && again.clusterKey === proof.clusterKey
        && Date.now() - proof.provenAt <= CROSS_PARK_PROOF_TTL_MS
}

/**
 * The bot waits 15 s for each answer. Every provider call of one request fits a
 * 12 s budget, each call is cut off after 4 s, and a provider change starts only
 * with time left to finish, so nothing changes after the bot has given up.
 */
const BOT_REQUEST_BUDGET_MS = 12_000
const PROVIDER_CALL_TIMEOUT_MS = 4_000
const PROVIDER_CHANGE_MIN_BUDGET_MS = 4_500

const PROVIDER_UNAVAILABLE_TEXT = 'Яндекс сейчас не отвечает. Попробуйте позже.'
const PROVIDER_RATE_LIMITED_TEXT = 'Яндекс временно ограничил запросы. Изменение не применено, попробуйте позже.'
// Answered with status 502 and no yandexError, which every bot flow prints as
// its text; 504 would read as "CRM unavailable" and invite a retry.
const PROVIDER_CHANGE_UNKNOWN_TEXT = 'Яндекс не подтвердил изменение. Проверьте результат позже и не повторяйте сразу.'

type ProviderDeadline = { readonly at: number }

function providerDeadline(): ProviderDeadline {
    return { at: Date.now() + BOT_REQUEST_BUDGET_MS }
}

/** An abort signal for one provider call: its own timeout, never past the request budget. */
function providerSignal(deadline: ProviderDeadline): AbortSignal {
    const remaining = deadline.at - Date.now()
    if (remaining <= 0) throw new Error('provider budget exhausted')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(PROVIDER_CALL_TIMEOUT_MS, remaining))
    ;(timer as { unref?: () => void }).unref?.()
    return controller.signal
}

/** Waits for a call whose request cannot carry a signal, no longer than one provider call. */
async function providerBound<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('provider call timed out')), PROVIDER_CALL_TIMEOUT_MS)
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** Whether a provider change still has time to finish inside the request budget. */
function providerChangeFits(deadline: ProviderDeadline): boolean {
    return deadline.at - Date.now() >= PROVIDER_CHANGE_MIN_BUDGET_MS
}

/** A provider answer that says nothing was done yet and a later attempt may succeed. */
function providerUnavailable(status: number): boolean {
    return status === 429 || status >= 500
}

/** Cars one link's own search just returned in one park: binding one of them needs no second listing. */
const CAR_SEARCH_MEMO_TTL_MS = 10 * 60_000
const CAR_SEARCH_MEMO_MAX = 500
const carSearchMemo = new Map<string, { linkDriverId: string; parkId: string; carIds: ReadonlySet<string>; at: number }>()

function rememberCarSearch(telegramId: string, linkDriverId: string, parkId: string, carIds: string[]): void {
    carSearchMemo.delete(telegramId)
    if (carSearchMemo.size >= CAR_SEARCH_MEMO_MAX) {
        const oldest = carSearchMemo.keys().next().value
        if (oldest !== undefined) carSearchMemo.delete(oldest)
    }
    carSearchMemo.set(telegramId, { linkDriverId, parkId, carIds: new Set(carIds), at: Date.now() })
}

/** Whether this link's own recent search in exactly this park returned the car, for the same link row. */
function carFromOwnSearch(telegramId: string, linkDriverId: string, parkId: string, carId: string): boolean {
    const memo = carSearchMemo.get(telegramId)
    if (!memo) return false
    if (Date.now() - memo.at > CAR_SEARCH_MEMO_TTL_MS) {
        carSearchMemo.delete(telegramId)
        return false
    }
    return memo.linkDriverId === linkDriverId && memo.parkId === parkId && memo.carIds.has(carId)
}

// Helper: find car by ID using paginated cars/list (same logic as getCarById in actions.ts)
async function findCarById(connection: any, carId: string, deadline: ProviderDeadline = providerDeadline()) {
    const lookup = await lookupParkCar(connection, carId, deadline)
    return lookup.state === 'found' ? lookup.car : null
}

/**
 * One of the connection park's own cars by id. `absent` only after the whole
 * listing was read; a failed page (429 included) or a listing longer than the
 * page budget is `unavailable`, never taken for a missing car.
 */
async function lookupParkCar(connection: any, carId: string, deadline: ProviderDeadline): Promise<
    | { state: 'found'; car: { brand: any; model: any; plate: any; color: any; year: any } }
    | { state: 'absent' }
    | { state: 'unavailable' }
> {
    const PAGE = 500
    const MAX_PAGES = 10
    const headers: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    for (let page = 0; page < MAX_PAGES; page++) {
        let data: any
        try {
            const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/cars/list', {
                method: 'POST',
                cache: 'no-store',
                headers,
                body: JSON.stringify({
                    query: { park: { id: connection.parkId } },
                    fields: { car: ['id', 'brand', 'model', 'color', 'year', 'number', 'status'] },
                    limit: PAGE,
                    offset: page * PAGE
                }),
                signal: providerSignal(deadline),
            })
            // 429 = rate-limited; other errors abort
            if (!res.ok) {
                console.warn('[findCarById] Yandex status', res.status, 'on page', page)
                return { state: 'unavailable' }
            }
            data = await res.json()
        } catch (error: unknown) {
            console.warn('[findCarById] Yandex car listing failed on page', page, error instanceof Error ? error.message : String(error))
            return { state: 'unavailable' }
        }
        const cars: any[] = data?.cars || []
        const found = cars.find((c: any) => c.id === carId)
        if (found) {
            return { state: 'found', car: { brand: found.brand, model: found.model, plate: found.number, color: found.color, year: found.year } }
        }
        // Use ?? null to distinguish "total=0" from "total missing"
        const total: number | null = data?.total ?? null
        if (total !== null && page * PAGE + cars.length >= total) return { state: 'absent' }
        if (total === null && cars.length < PAGE) return { state: 'absent' } // last page (no total field)
    }
    return { state: 'unavailable' }
}

// ── Cash compensation pilot ────────────────────────────────────────────────
// The bot renders; every rule lives behind compensationPilotSectionV1,
// compensationPilotOrderCheckV1, compensationPilotRefreshV1 and
// compensationPilotSubmitV1, so the surfaces cannot drift apart. The person is
// proven here through current Telegram Driver authority, the same gate as every
// other bot Driver action; this block never creates or changes a link. The
// selected park is read from that same link in the same request and never
// taken from the bot, so a list shown for one park cannot be acted on in another.

function serializeCompensationApplication(application: {
    applicationId: string
    status: string
    shortOrderIdDisplay: string | null
    amountKopecks: number
    submittedAt: Date
    rejectionReason: string | null
}) {
    return {
        applicationId: application.applicationId,
        status: application.status,
        shortOrderId: application.shortOrderIdDisplay,
        amountKopecks: application.amountKopecks,
        submittedAt: application.submittedAt.toISOString(),
        rejectionReason: application.rejectionReason,
    }
}

function serializeCompensationOrder(order: {
    externalOrderId: string
    shortOrderIdDisplay: string | null
    amountKopecks: number
    endedAt: Date
    dayKey: string
    localTime: string
    localDate: string
    claimed: boolean
}) {
    return {
        externalOrderId: order.externalOrderId,
        shortOrderId: order.shortOrderIdDisplay,
        amountKopecks: order.amountKopecks,
        endedAt: order.endedAt.toISOString(),
        dayKey: order.dayKey,
        localTime: order.localTime,
        localDate: order.localDate,
        claimed: order.claimed,
    }
}

type CompensationPersonProof =
    | {
        proven: true
        telegramUserId: string
        driverId: string
        contactId: string
        selectedExternalParkId: string | null
    }
    | { proven: false; response: NextResponse | null }

async function proveCompensationTelegramPerson(payload: any): Promise<CompensationPersonProof> {
    const telegramUserId = typeof payload?.telegramId === 'string' || typeof payload?.telegramId === 'number'
        ? String(payload.telegramId)
        : ''
    if (!/^\d+$/u.test(telegramUserId) || /^0+$/u.test(telegramUserId)) {
        return {
            proven: false,
            response: NextResponse.json({ error: 'Missing telegramId' }, { status: 400 }),
        }
    }
    const telegramId = BigInt(telegramUserId)
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId },
        select: { driverId: true, activeParkId: true },
    })
    // No manager link yet: the in-band refusal, not an authority failure.
    if (!mapping || !mapping.driverId) return { proven: false, response: null }

    const authority = await resolveCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId,
    })
    if (!authority) {
        return {
            proven: false,
            response: NextResponse.json({
                error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
            }, { status: 409 }),
        }
    }
    return {
        proven: true,
        // The canonical decimal form authority proved, never the raw payload.
        telegramUserId: telegramId.toString(),
        driverId: mapping.driverId,
        contactId: authority.contactId,
        // The link's own selection, read with the proof. The payload has none.
        selectedExternalParkId: mapping.activeParkId ?? null,
    }
}

function compensationProofFields(proof: Extract<CompensationPersonProof, { proven: true }>) {
    return {
        telegramUserId: proof.telegramUserId,
        driverId: proof.driverId,
        contactId: proof.contactId,
        selectedExternalParkId: proof.selectedExternalParkId,
    }
}

async function handleCompensationSection(payload: any) {
    const proof = await proveCompensationTelegramPerson(payload)
    if (!proof.proven) {
        return proof.response ?? NextResponse.json({
            available: false,
            reason: 'identity_not_proven',
            applications: [],
        })
    }

    const search = typeof payload?.search === 'string' ? payload.search.slice(0, 40) : null
    const view = await compensationPilotSectionV1(compensationProofFields(proof), { search })
    if (!view.available) {
        return NextResponse.json({
            available: false,
            reason: view.reason,
            applications: view.applications.map(serializeCompensationApplication),
        })
    }
    return NextResponse.json({
        available: true,
        scopeKey: view.scopeKey,
        monthKey: view.firstMonthKey,
        remainingBudgetKopecks: view.remainingBudgetKopecks,
        catalogueStatus: view.catalogueStatus,
        todayKey: view.todayKey,
        orders: view.orders.map(serializeCompensationOrder),
        search: view.search === null ? null : {
            query: view.search.query,
            kind: view.search.kind,
            truncated: view.search.truncated,
            externalOrderIds: view.search.matches.map((order) => order.externalOrderId),
        },
        applications: view.applications.map(serializeCompensationApplication),
    })
}

async function handleCompensationOrderCheck(payload: any) {
    const externalOrderId = typeof payload?.externalOrderId === 'string' ? payload.externalOrderId : ''
    if (!payload?.telegramId || !externalOrderId) {
        return NextResponse.json({ error: 'Missing telegramId or externalOrderId' }, { status: 400 })
    }

    const proof = await proveCompensationTelegramPerson(payload)
    if (!proof.proven) {
        return proof.response ?? NextResponse.json({ state: 'refused', refusal: 'identity_not_proven', order: null })
    }

    const check = await compensationPilotOrderCheckV1({
        ...compensationProofFields(proof),
        externalOrderId,
        // Echoed from the list the bot showed; the service compares it with the
        // scope it rebuilds now.
        scopeKey: typeof payload?.scopeKey === 'string' ? payload.scopeKey : '',
        retry: payload?.retry === true,
    })
    return NextResponse.json({
        state: check.state,
        refusal: check.refusal,
        order: check.order === null ? null : serializeCompensationOrder(check.order),
    })
}

async function handleCompensationRefresh(payload: any) {
    const proof = await proveCompensationTelegramPerson(payload)
    if (!proof.proven) {
        return proof.response ?? NextResponse.json({ status: 'refused', refusal: 'identity_not_proven' })
    }

    const outcome = await compensationPilotRefreshV1(compensationProofFields(proof))
    return NextResponse.json({ status: outcome.status, refusal: outcome.refusal })
}

async function handleCompensationSubmit(payload: any) {
    const { externalOrderId, claimedRubles, supportConfirmed, attachmentFileId, attachmentKind, idempotencyKey } = payload ?? {}
    if (!payload?.telegramId || !externalOrderId) {
        return NextResponse.json({ error: 'Missing telegramId or externalOrderId' }, { status: 400 })
    }
    // The bot supplies the key so a retried tap is the same logical submit.
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
        return NextResponse.json({ error: 'Missing idempotencyKey' }, { status: 400 })
    }

    const proof = await proveCompensationTelegramPerson(payload)
    if (!proof.proven) {
        return proof.response ?? NextResponse.json({ submitted: false, refusal: 'identity_not_proven' })
    }

    const outcome = await compensationPilotSubmitV1({
        ...compensationProofFields(proof),
        externalOrderId: String(externalOrderId),
        // A non-numeric amount becomes NaN, which the gate refuses as not whole
        // rubles rather than coercing it into something plausible.
        claimedRubles: Number(claimedRubles),
        supportConfirmed: supportConfirmed === true,
        attachmentFileId: attachmentFileId ? String(attachmentFileId) : null,
        attachmentKind: attachmentKind ? String(attachmentKind) : null,
        idempotencyKey,
        scopeKey: typeof payload?.scopeKey === 'string' ? payload.scopeKey : '',
    })

    if (!outcome.submitted) {
        return NextResponse.json({ submitted: false, refusal: outcome.refusal })
    }
    return NextResponse.json({
        submitted: true,
        applicationId: outcome.applicationId,
        amountKopecks: outcome.amountKopecks,
        status: outcome.status,
    })
}

// Handle a phone submitted through the driver bot. Generic bot ingress is a
// local-CRM-only path: provider/Fleet refresh belongs to the explicit park
// search and reconciliation workflows, never this request.
async function handleSyncUser(payload: unknown) {
    const input = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
    const { telegramId, contactUserId } = input
    const phone = typeof input.phone === 'string' ? input.phone.trim() : ''
    const username = typeof input.username === 'string' && input.username.trim() ? input.username.trim() : null
    const firstName = typeof input.firstName === 'string' && input.firstName.trim() ? input.firstName.trim() : null
    const lastName = typeof input.lastName === 'string' && input.lastName.trim() ? input.lastName.trim() : null

    if (!telegramId || !phone) {
        return NextResponse.json({ error: 'Missing telegramId or phone' }, { status: 400 })
    }

    const telegramIdText = String(telegramId).trim()
    if (!/^\d+$/.test(telegramIdText) || telegramIdText === '0') {
        return NextResponse.json({ error: 'Invalid telegramId' }, { status: 400 })
    }
    const normalizedPhone = normalizePhoneE164(String(phone))
    if (!normalizedPhone) {
        return NextResponse.json({ error: 'Invalid phone' }, { status: 400 })
    }

    // Telegram contact cards prove ownership only when their immutable
    // contact.user_id equals the authenticated sender id. Older/manual retry
    // payloads have no contactUserId and remain unverified, but are still kept
    // for manager review.
    const hasContactOwnershipEvidence = contactUserId !== undefined && contactUserId !== null
    if (hasContactOwnershipEvidence && String(contactUserId).trim() !== telegramIdText) {
        return NextResponse.json({
            error: 'CONTACT_OWNER_MISMATCH',
            message: 'Пожалуйста, отправьте свой контакт.',
        }, { status: 409 })
    }

    const observedAt = new Date()
    await recordBotUserProfileV1({
        contract: RECORD_BOT_USER_PROFILE_COMMAND_V1,
        telegramId: BigInt(telegramIdText),
        username,
        firstName,
        lastName,
        // Never replace a previously verified registry phone with an
        // unverified retry payload. The pending request retains that claim for
        // operator review without upgrading its trust.
        phone: hasContactOwnershipEvidence ? normalizedPhone : null,
        phoneVerified: hasContactOwnershipEvidence,
        observedAt,
    })

    // An existing Telegram→Driver mapping is durable local authority. Never
    // move it because of a newly submitted phone; simply report the existing
    // link. Creating a new physical-driver link requires the explicit manager
    // or canonical reconciliation workflow.
    const existingLink = await prisma.driverTelegram.findUnique({
        where: { telegramId: BigInt(telegramIdText) },
        select: { driverId: true, username: true },
    })
    if (existingLink?.driverId) {
        return NextResponse.json({
            success: true,
            autoLinked: true,
            alreadyLinked: true,
            driverId: existingLink.driverId,
            driverName: existingLink.username || null,
        })
    }

    // A phone alone cannot select one of several park-qualified Driver rows or
    // override a stable channel owner. Persist the evidence and fail closed to
    // the manager-link queue; scheduled/manual Fleet reconciliation can refresh
    // provider data independently.
    await recordPendingBotLinkRequestV1({
        contract: RECORD_PENDING_BOT_LINK_REQUEST_COMMAND_V1,
        telegramId: telegramIdText,
        text: `[Запрос привязки] Телефон: ${normalizedPhone}, @${username || 'нет'}`,
    })

    // Notify manager: drop a system message into the driver's existing TG chat
    await notifyManagerPendingLink({ telegramId: telegramIdText, username: username ?? undefined, phone: normalizedPhone })

    return NextResponse.json({
        success: true,
        autoLinked: false,
        status: 'PENDING_MANAGER_LINK',
        message: 'Pending manual link by manager',
    })
}

// Inject a system message into the driver's TG chat so the manager sees the pending link request
async function notifyManagerPendingLink({ telegramId, username, phone }: {
    telegramId: string
    username?: string
    phone?: string
}) {
    try {
        const chat = await prisma.chat.findFirst({
            where: { channel: 'telegram', externalChatId: String(telegramId) },
            select: { id: true },
        })
        if (!chat) return

        const userLabel = username ? `@${username}` : `TG ID ${telegramId}`
        const phoneLabel = phone ? `+${phone.replace(/^\+/, '')}` : 'не известен'

        await sendMessageV1({
            contract: SEND_MESSAGE_COMMAND_V1,
            operation: APPEND_SYSTEM_NOTIFICATION_V1,
            chatId: chat.id,
            channel: 'telegram',
            content: `⚠️ Запрос привязки TG Бота\n\nДля водителя ${userLabel} недостаточно локальных подтверждённых данных для автоматической привязки.\nТелефон: ${phoneLabel}\nTG ID: ${telegramId}\n\nПривяжите вручную: карточка контакта → «Привязать к водителю».`,
            externalId: `bot_link_req_${telegramId}_${Date.now()}`,
            sentAt: new Date().toISOString(),
        })

        await updateConversationV1({
            contract: UPDATE_CONVERSATION_COMMAND_V1,
            operation: MARK_REQUIRES_RESPONSE_V1,
            chatId: chat.id,
            lastMessageAt: new Date().toISOString(),
        })
    } catch (err: any) {
        console.error('[notifyManagerPendingLink] Error:', err.message)
    }
}

async function handleChangeLimit(payload: any) {
    const { telegramId, limitValue } = payload

    if (!telegramId || limitValue === undefined || limitValue < 1) {
        return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
    }

    // 1. Find the driver mapping
    const deadline = providerDeadline()
    const telegramIdBigInt = BigInt(telegramId)
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: telegramIdBigInt }
    })

    if (!mapping) {
        return NextResponse.json({ error: 'NOT_LINKED', message: 'Driver not linked to this Telegram ID' }, { status: 404 })
    }
    const authorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (authorityFailure) return authorityFailure

    // 2. Resolve the Yandex profile and the park it belongs to.
    //    mapping.driverId is a CRM id — need the Yandex contractor id. In
    //    another park of the same person it is that park's own Driver row.
    const anchor: BotDriverRow | null = await prisma.driver.findUnique({
        where: { id: mapping.driverId },
        select: BOT_DRIVER_SELECT,
    })
    const acting = await botActingDriver(payload, mapping, telegramIdBigInt, anchor)
    const driver = acting.driver
    const target = driverYandexTarget(driver, mapping.activeParkId)
    if (!target.ok) {
        return target.reason === 'PARK_UNPROVEN'
            ? NextResponse.json({ error: PROFILE_PARK_UNPROVEN_TEXT }, { status: 409 })
            : NextResponse.json({ error: 'Не удалось найти водителя в Яндекс Флит для этого парка' }, { status: 404 })
    }
    let contractorId: string | null = target.profileId

    // 3. Use the connection of that park. A legacy id may be absent from it, so
    //    fall back to an exact phone match there when v2 returns 404.
    const connection = await getYandexConnectionCredentialsV1(undefined, target.parkId)

    if (!connection) {
        return NextResponse.json({ error: 'No active Yandex API connection in CRM' }, { status: 500 })
    }

    const yandexAuthHeaders: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'X-Park-ID': connection.parkId,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    const safeJson = async (res: Response) => {
        const text = await res.text()
        console.log(`[safeJson] status=${res.status} ok=${res.ok} body_preview="${text.substring(0, 100)}"`)
        try {
            return { ok: res.ok, status: res.status, data: JSON.parse(text) }
        } catch { return { ok: res.ok, status: res.status, data: { raw: text.substring(0, 300) } } }
    }

    // Quick probe — if 404, resolve contractor id via phone search in active park.
    // A proven Driver row of another park is never replaced by a phone match.
    if (contractorId && acting.crossPark === null) {
        try {
            const probe = await fetch(`https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${contractorId}`, {
                method: 'GET', headers: yandexAuthHeaders, signal: providerSignal(deadline)
            })
            if (probe.status === 404 && driver?.phone) {
                console.log(`[changeLimit] yandexDriverId 404 in park ${connection.parkId}, searching by phone`)
                const searchRes = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                    method: 'POST',
                    headers: yandexAuthHeaders,
                    body: JSON.stringify({
                        query: { park: { id: connection.parkId }, text: driver.phone },
                        fields: { driver_profile: ['id', 'phones'], car: [], account: [], current_status: [] },
                        limit: 5, offset: 0
                    }),
                    signal: providerSignal(deadline),
                })
                if (searchRes.ok) {
                    const searchData = await searchRes.json()
                    const matched = uniqueProfileByPhone(searchData.driver_profiles || [], driver.phone)
                    if (matched?.driver_profile?.id) {
                        contractorId = matched.driver_profile.id
                        console.log(`[changeLimit] resolved contractor id via phone: ${contractorId}`)
                    }
                }
            } else if (providerUnavailable(probe.status)) {
                return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
            }
        } catch (error: any) {
            console.warn('[changeLimit] profile probe failed:', error?.message)
            return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
        }
    }

    if (!contractorId) {
        return NextResponse.json({ error: 'Не удалось найти водителя в Яндекс Флит для этого парка' }, { status: 404 })
    }

    try {
        // Step 3a: GET current contractor profile (returns exact structure needed for PUT)
        const contractorUrl = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${contractorId}`
        console.log(`[changeLimit] GET contractor profile: ${contractorUrl}`)
        let current: { ok: boolean; status: number; data: any }
        try {
            current = await safeJson(await fetch(contractorUrl, {
                method: 'GET',
                headers: yandexAuthHeaders,
                signal: providerSignal(deadline),
            }))
        } catch (error: any) {
            console.warn('[changeLimit] GET failed:', error?.message)
            return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
        }
        const { ok: getOk, status: getStatus, data: currentProfile } = current
        console.log(`[changeLimit] GET Response ${getStatus}:`, JSON.stringify(currentProfile).substring(0, 500))

        if (!getOk) {
            if (providerUnavailable(getStatus)) return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
            return NextResponse.json({ error: `Yandex GET Error ${getStatus}`, yandexError: currentProfile }, { status: 502 })
        }

        // Step 3b: PUT with the same profile but updated balance_limit
        const putBody = {
            ...currentProfile,
            account: {
                ...(currentProfile.account || {}),
                balance_limit: limitValue.toString()
            }
        }

        console.log(`[changeLimit] PUT ${contractorUrl} with balance_limit=${limitValue}`)
        const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (mutationAuthorityFailure) return mutationAuthorityFailure
        if (!(await crossParkProofStillHolds(payload, telegramIdBigInt, anchor, acting.crossPark))) {
            return NextResponse.json({ error: PROFILE_PARK_UNPROVEN_TEXT }, { status: 409 })
        }
        if (!providerChangeFits(deadline)) {
            return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
        }
        let put: { ok: boolean; status: number; data: any }
        try {
            put = await safeJson(await fetch(contractorUrl, {
                method: 'PUT',
                headers: yandexAuthHeaders,
                body: JSON.stringify(putBody),
                signal: providerSignal(deadline),
            }))
        } catch (error: any) {
            // The request may have reached Yandex: the outcome is unknown, never a success.
            console.warn('[changeLimit] PUT outcome unknown:', error?.message)
            return NextResponse.json({ error: PROVIDER_CHANGE_UNKNOWN_TEXT, outcome: 'UNKNOWN' }, { status: 502 })
        }
        const { ok: putOk, status: putStatus, data: putData } = put
        console.log(`[changeLimit] PUT Response ${putStatus}:`, JSON.stringify(putData).substring(0, 300))

        if (!putOk) {
            if (putStatus === 429) return NextResponse.json({ error: PROVIDER_RATE_LIMITED_TEXT }, { status: 503 })
            if (putStatus >= 500) return NextResponse.json({ error: PROVIDER_CHANGE_UNKNOWN_TEXT, outcome: 'UNKNOWN' }, { status: 502 })
            return NextResponse.json({ error: `Yandex PUT Error ${putStatus}`, yandexError: { code: putStatus, ...putData } }, { status: 502 })
        }

        return NextResponse.json({ success: true, newLimit: limitValue })
    } catch (err: any) {
        console.error('[changeLimit] Exception:', err.message, err.stack)
        return NextResponse.json({ error: `changeLimit exception: ${err.message}` }, { status: 500 })
    }
}

// Search cars by plate prefix (min 6 chars). Yandex ignores filters, so we paginate all cars.
async function handleSearchCarByPlate(payload: any) {
    const { platePrefix, telegramId } = payload
    if (!platePrefix || platePrefix.length < 3) {
        return NextResponse.json({ error: 'platePrefix must be at least 3 characters' }, { status: 400 })
    }

    // Use driver's activeParkId if telegramId provided
    const deadline = providerDeadline()
    let connection = null
    let searchLink: { telegramId: string; driverId: string } | null = null
    if (telegramId) {
        const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: BigInt(telegramId) } })
        if (mapping?.driverId) searchLink = { telegramId: BigInt(telegramId).toString(), driverId: mapping.driverId }
        if (mapping?.activeParkId) {
            connection = await getYandexConnectionCredentialsV1(undefined, mapping.activeParkId)
        }
    }
    if (!connection) connection = await getYandexConnectionCredentialsV1()
    if (!connection) return NextResponse.json({ error: 'No Yandex connection' }, { status: 503 })

    const prefix = platePrefix.toUpperCase().replace(/\s/g, '')
    const matches: any[] = []
    const PAGE = 500
    let pagesRead = 0

    try {
        for (let page = 0; page < 10; page++) {
            let data: any
            try {
                const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/cars/list', {
                    method: 'POST',
                    cache: 'no-store',
                    headers: {
                        'X-Client-ID': connection.clid,
                        'X-Api-Key': connection.apiKey,
                        'Accept-Language': 'ru',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        query: { park: { id: connection.parkId } },
                        fields: { car: ['id', 'brand', 'model', 'color', 'year', 'number', 'status'] },
                        limit: PAGE,
                        offset: page * PAGE
                    }),
                    signal: providerSignal(deadline),
                })
                if (!res.ok) break
                data = await res.json()
                pagesRead += 1
            } catch (error: any) {
                // Out of time or unreachable: answer with what the earlier pages found.
                console.warn('[search_car_by_plate] page', page, 'not read:', error?.message)
                break
            }
            const cars: any[] = data?.cars || []

            for (const c of cars) {
                const plate = (c.number || '').toUpperCase().replace(/\s/g, '')
                if (plate.startsWith(prefix)) {
                    matches.push({ id: c.id, brand: c.brand, model: c.model, plate: c.number, year: c.year, color: c.color })
                    if (matches.length >= 5) break // Max 5 results
                }
            }

            if (matches.length >= 5 || page * PAGE + cars.length >= (data?.total || 0)) break
        }

        // Not one page read: Yandex did not answer, which is not "no such car".
        if (pagesRead === 0) return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
        // Binding one of these cars right after needs no second listing of this park.
        if (searchLink && matches.length > 0) {
            rememberCarSearch(searchLink.telegramId, searchLink.driverId, connection.parkId, matches.map((car) => String(car.id)))
        }
        return NextResponse.json({ found: matches.length > 0, cars: matches })
    } catch (err: any) {
        console.error('[search_car_by_plate] Error:', err.message)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

// Update driver's car assignment in Yandex via GET + PUT contractor profile
async function handleUpdateDriverCar(payload: any) {
    const { telegramId, carId } = payload
    if (!telegramId || !carId) {
        return NextResponse.json({ error: 'Missing telegramId or carId' }, { status: 400 })
    }

    const deadline = providerDeadline()
    const telegramIdBigInt = BigInt(telegramId)
    const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: telegramIdBigInt } })
    if (!mapping?.driverId) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 })
    const authorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (authorityFailure) return authorityFailure

    // The link names a CRM Driver row; Yandex needs that Driver's profile id.
    // In another park of the same person it is that park's own Driver row.
    let anchor: BotDriverRow | null = await prisma.driver.findUnique({
        where: { id: mapping.driverId },
        select: BOT_DRIVER_SELECT,
    })
    if (!anchor) {
        anchor = await prisma.driver.findFirst({
            where: { yandexDriverId: mapping.driverId },
            select: BOT_DRIVER_SELECT,
        })
    }
    const acting = await botActingDriver(payload, mapping, telegramIdBigInt, anchor)
    const driver = acting.driver
    const target = driverYandexTarget(driver, mapping.activeParkId)
    if (!target.ok) {
        return target.reason === 'PARK_UNPROVEN'
            ? NextResponse.json({ error: PROFILE_PARK_UNPROVEN_TEXT }, { status: 409 })
            : NextResponse.json({ error: 'Не нашли ваш профиль в Яндекс Флит. Обратитесь к менеджеру.' }, { status: 404 })
    }
    const contractorId = target.profileId

    const connection = await getYandexConnectionCredentialsV1(undefined, target.parkId)
    if (!connection) return NextResponse.json({ error: 'No Yandex connection' }, { status: 503 })

    const headers: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'X-Park-ID': connection.parkId,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    const safeJson = async (res: Response) => {
        const text = await res.text()
        try {
            return { ok: res.ok, status: res.status, data: JSON.parse(text) }
        } catch { return { ok: res.ok, status: res.status, data: { raw: text } } }
    }

    try {
        // The bot sends only the car id it found while some park was selected.
        // A car is bound only if it is one of this park's own cars, so a car
        // found before a park switch is never bound to another park's profile.
        // A listing Yandex did not finish proves nothing and binds nothing. A car
        // this link's own search just found in this very park needs no listing.
        const parkCar = carFromOwnSearch(telegramIdBigInt.toString(), mapping.driverId, target.parkId, String(carId))
            ? { state: 'found' as const }
            : await lookupParkCar(connection, String(carId), deadline)
        if (parkCar.state === 'unavailable') {
            return NextResponse.json({ error: 'Не удалось проверить автомобиль в Яндексе. Попробуйте позже.' }, { status: 503 })
        }
        if (parkCar.state === 'absent') {
            return NextResponse.json({ error: 'Этот автомобиль не найден в выбранном парке. Найдите автомобиль заново.' }, { status: 409 })
        }

        const contractorUrl = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${contractorId}`
        let current: { ok: boolean; status: number; data: any }
        try {
            current = await safeJson(await fetch(contractorUrl, { method: 'GET', headers, signal: providerSignal(deadline) }))
        } catch (error: any) {
            console.warn('[update_driver_car] GET failed:', error?.message)
            return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
        }
        const { ok: getOk, status: getStatus, data: profile } = current
        if (!getOk) {
            if (providerUnavailable(getStatus)) return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
            return NextResponse.json({ error: 'Failed to fetch driver profile', details: profile }, { status: 502 })
        }

        const putBody = { ...profile, car_id: carId }
        const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (mutationAuthorityFailure) return mutationAuthorityFailure
        if (!(await crossParkProofStillHolds(payload, telegramIdBigInt, anchor, acting.crossPark))) {
            return NextResponse.json({ error: PROFILE_PARK_UNPROVEN_TEXT }, { status: 409 })
        }
        if (!providerChangeFits(deadline)) {
            return NextResponse.json({ error: PROVIDER_UNAVAILABLE_TEXT }, { status: 503 })
        }
        let put: { ok: boolean; status: number; data: any }
        try {
            put = await safeJson(await fetch(contractorUrl, {
                method: 'PUT', headers, body: JSON.stringify(putBody), signal: providerSignal(deadline)
            }))
        } catch (error: any) {
            // The request may have reached Yandex: the outcome is unknown, never a success.
            console.warn('[update_driver_car] PUT outcome unknown:', error?.message)
            return NextResponse.json({ error: PROVIDER_CHANGE_UNKNOWN_TEXT, outcome: 'UNKNOWN' }, { status: 502 })
        }
        const { ok: putOk, status: putStatus, data: putData } = put
        console.log(`[update_driver_car] PUT ${putStatus}:`, JSON.stringify(putData).substring(0, 200))

        if (!putOk) {
            if (putStatus === 429) return NextResponse.json({ error: PROVIDER_RATE_LIMITED_TEXT }, { status: 503 })
            if (putStatus >= 500) return NextResponse.json({ error: PROVIDER_CHANGE_UNKNOWN_TEXT, outcome: 'UNKNOWN' }, { status: 502 })
            return NextResponse.json({ error: `Yandex error ${putStatus}`, details: putData }, { status: 502 })
        }
        return NextResponse.json({ success: true, newCarId: carId })
    } catch (err: any) {
        console.error('[update_driver_car] Error:', err.message)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Driver-actions bridge — proxies "Цена / Завершить / Отменить" between
// TG bot and yandex-fleet-scraper. Resolves telegramId → Driver → Yandex
// profile id, persists a DriverAction audit row, enqueues a scraper task,
// returns taskId so the bot can poll.
// ────────────────────────────────────────────────────────────────────────────

const SCRAPER_URL = process.env.YANDEX_FLEET_SCRAPER_URL || 'http://localhost:3003'

type DriverActionKind = 'GET_PRICE' | 'COMPLETE_ORDER' | 'CANCEL_ORDER'

async function handleDriverAction(payload: any, kind: DriverActionKind) {
    const { telegramId, reason } = payload || {}
    if (!telegramId) {
        return NextResponse.json({ ok: false, error: 'Missing telegramId' }, { status: 400 })
    }

    // 1. Resolve telegram → driver → Yandex profile id
    const deadline = providerDeadline()
    const telegramIdBigInt = BigInt(telegramId)
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: telegramIdBigInt }
    })
    if (!mapping?.driverId) {
        return NextResponse.json({
            ok: false,
            error: 'NOT_LINKED',
            message: 'Профиль не привязан. Нажмите «Мой автомобиль» и поделитесь номером.',
        })
    }
    const authorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (authorityFailure) return authorityFailure
    let driver: BotDriverRow | null = await prisma.driver.findUnique({
        where: { id: mapping.driverId },
        select: BOT_DRIVER_SELECT,
    })
    if (!driver) {
        driver = await prisma.driver.findFirst({
            where: { yandexDriverId: mapping.driverId },
            select: BOT_DRIVER_SELECT,
        })
    }
    // In another park of the same person the action runs, and is audited, on
    // that park's own Driver row; the task is fixed to it when dispatched.
    const anchor = driver
    const acting = await botActingDriver(payload, mapping, telegramIdBigInt, anchor)
    driver = acting.driver
    const target = driverYandexTarget(driver, mapping.activeParkId)
    if (driver && !target.ok && target.reason === 'PARK_UNPROVEN') {
        const recordAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (recordAuthorityFailure) return recordAuthorityFailure
        await recordDriverActionV1({
            contract: RECORD_DRIVER_ACTION_COMMAND_V1,
            data: {
                driverId: driver.id,
                kind,
                requestedBy: String(telegramId),
                status: 'ESCALATED_TO_MANAGER',
                errorMessage: 'selected park is not the park of the Yandex profile',
            },
        }).catch(() => {})
        return NextResponse.json({
            ok: false,
            error: 'YANDEX_PROFILE_PARK_UNPROVEN',
            status: 'ESCALATED_TO_MANAGER',
            message: PROFILE_PARK_UNPROVEN_TEXT,
        })
    }
    if (!driver || !target.ok) {
        const recordAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (recordAuthorityFailure) return recordAuthorityFailure
        await recordDriverActionV1({
            contract: RECORD_DRIVER_ACTION_COMMAND_V1,
            data: {
                driverId: mapping.driverId,
                kind,
                requestedBy: String(telegramId),
                status: 'ESCALATED_TO_MANAGER',
                errorMessage: 'driver has no yandexDriverId',
            },
        }).catch(() => {})
        return NextResponse.json({
            ok: false,
            error: 'NO_YANDEX_ID',
            message: 'Не нашли ваш профиль в Яндексе. Менеджер обработает запрос.',
        })
    }

    // 2a. Profile-swap guard: if the linked profile is fired, use the driver's own
    //     working twin in the same park — only the single one with the driver's phone.
    //     A proven Driver row of another park is never swapped by name or phone.
    let effectiveYandexId = target.profileId
    try {
        const conn = await getYandexConnectionCredentialsV1(undefined, target.parkId)
        if (conn && driver.fullName && acting.crossPark === null) {
            const checkRes = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                method: 'POST',
                headers: { 'X-Client-ID': conn.clid, 'X-Api-Key': conn.apiKey, 'Accept-Language': 'ru', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: { park: { id: conn.parkId }, text: driver.fullName },
                    fields: { driver_profile: ['id', 'first_name', 'last_name', 'phones', 'work_status'], car: [], account: [], current_status: [] },
                    limit: 10, offset: 0
                }),
                signal: providerSignal(deadline),
            })
            if (checkRes.ok) {
                const checkData = await checkRes.json()
                const profiles: any[] = checkData.driver_profiles || []
                const linked = profiles.find((p: any) => p.driver_profile.id === effectiveYandexId)
                if (linked?.driver_profile.work_status === 'fired') {
                    const twin = uniqueProfileByPhone(profiles, driver.phone, (p: any) =>
                        p.driver_profile.id !== effectiveYandexId &&
                        p.driver_profile.work_status !== 'fired'
                    )
                    if (twin) {
                        console.log(`[handleDriverAction] profile swap detected: ${effectiveYandexId} fired → using twin ${twin.driver_profile.id}`)
                        effectiveYandexId = twin.driver_profile.id
                    }
                }
            }
        }
    } catch (e: any) {
        console.warn(`[handleDriverAction] swap-guard failed: ${e.message}`)
    }

    // 2b. Enqueue scraper task — Playwright on fleet.yandex.ru (price, map, full addresses)
    let scraperTaskId: string | null = null
    try {
        const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (mutationAuthorityFailure) return mutationAuthorityFailure
        if (!(await crossParkProofStillHolds(payload, telegramIdBigInt, anchor, acting.crossPark))) {
            await recordDriverActionV1({
                contract: RECORD_DRIVER_ACTION_COMMAND_V1,
                data: {
                    driverId: driver.id,
                    kind,
                    requestedBy: String(telegramId),
                    status: 'ESCALATED_TO_MANAGER',
                    errorMessage: 'proof of the selected park no longer held at dispatch',
                },
            }).catch(() => {})
            return NextResponse.json({
                ok: false,
                error: 'YANDEX_PROFILE_PARK_UNPROVEN',
                status: 'ESCALATED_TO_MANAGER',
                message: PROFILE_PARK_UNPROVEN_TEXT,
            })
        }
        if (!providerChangeFits(deadline)) {
            return NextResponse.json({
                ok: false,
                error: 'PROVIDER_SLOW',
                message: 'Система отвечает медленно. Попробуйте ещё раз.',
            })
        }
        const res = await fetch(`${SCRAPER_URL}/api/driver-actions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind,
                driverYandexId: effectiveYandexId,
                parkId: target.parkId,
                reason: reason || (kind === 'CANCEL_ORDER' ? 'Отменено водителем' : null),
            }),
            signal: providerSignal(deadline),
        })
        const json = await res.json()
        if (!res.ok || !json.taskId) {
            throw new Error(json.error || `scraper ${res.status}`)
        }
        scraperTaskId = json.taskId
    } catch (caught: any) {
        // A dispatch that timed out may still have been queued: it is recorded as
        // failed with an unknown outcome and is never retried here.
        const e = caught?.name === 'AbortError' ? new Error('dispatch timed out, outcome unknown') : caught
        const recordAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (recordAuthorityFailure) return recordAuthorityFailure
        await recordDriverActionV1({
            contract: RECORD_DRIVER_ACTION_COMMAND_V1,
            data: {
                driverId: driver.id,
                kind,
                requestedBy: String(telegramId),
                status: 'FAILED',
                errorMessage: `scraper unreachable: ${e.message}`,
            },
        }).catch(() => {})
        return NextResponse.json({
            ok: false,
            error: 'SCRAPER_DOWN',
            message: 'Система временно недоступна. Менеджер обработает запрос.',
        })
    }

    // 3. Audit row in CRM
    const recordAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (recordAuthorityFailure) return recordAuthorityFailure
    const { action } = await recordDriverActionV1({
        contract: RECORD_DRIVER_ACTION_COMMAND_V1,
        data: {
            driverId: driver.id,
            kind,
            requestedBy: String(telegramId),
            status: 'PENDING',
            scraperTaskId,
        },
    })

    return NextResponse.json({
        ok: true,
        actionId: action.id,
        taskId: scraperTaskId,
        status: 'PENDING',
        message: '⏳ Передаю в систему…',
    })
}

async function handleListParks() {
    const parks = await listYandexConnectionMetadataV1()
    return NextResponse.json({
        parks: parks.map(p => ({ parkId: p.parkId, name: p.name || p.parkId }))
    })
}

async function handleSetActivePark(payload: any) {
    const { telegramId, parkId } = payload
    if (!telegramId || !parkId) return NextResponse.json({ error: 'Missing params' }, { status: 400 })

    const telegramIdBigInt = BigInt(telegramId)
    const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: telegramIdBigInt } })
    if (!mapping) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 })
    const authorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (authorityFailure) return authorityFailure

    const park = await getYandexConnectionCredentialsV1(undefined, parkId)
    if (!park) return NextResponse.json({ error: 'PARK_NOT_FOUND' }, { status: 404 })

    // Verify driver exists in this park via Yandex Fleet
    try {
        const driver = await prisma.driver.findUnique({
            where: { id: mapping.driverId },
            select: { phone: true, yandexDriverId: true }
        })
        const phone = driver?.phone
        if (phone) {
            const searchRes = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                method: 'POST',
                headers: {
                    'X-Client-ID': park.clid,
                    'X-Api-Key': park.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: { park: { id: parkId }, text: phone },
                    fields: { driver_profile: ['id', 'phones', 'work_status'], car: [], account: [], current_status: [] },
                    limit: 5, offset: 0
                }),
                signal: providerSignal(providerDeadline()),
            })
            if (searchRes.ok) {
                const searchData = await searchRes.json()
                const normalizedPhone = phone.replace(/[\s+\-()]/g, '')
                const found = (searchData.driver_profiles || []).some((p: any) =>
                    (p.driver_profile.phones || []).some((ph: string) =>
                        ph.replace(/[\s+\-()]/g, '').includes(normalizedPhone)
                    )
                )
                if (!found) {
                    console.log(`[setActivePark] driver phone ${phone} not found in park ${parkId}`)
                    return NextResponse.json({ error: 'NOT_IN_PARK', parkName: park.name || parkId }, { status: 403 })
                }
            }
        }
    } catch (err: any) {
        console.error('[setActivePark] park validation error:', err.message)
        // Don't block if Yandex check fails — allow the switch
    }

    const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (mutationAuthorityFailure) return mutationAuthorityFailure
    await patchDriverTelegramLinkV1({ contract: PATCH_DRIVER_TELEGRAM_LINK_COMMAND_V1, mappingId: mapping.id, patch: { activeParkId: parkId, carLabel: null, carId: null } })
    return NextResponse.json({ success: true, parkName: park.name || parkId })
}

async function handleGetParkInfo(payload: any) {
    const { telegramId } = payload
    if (!telegramId) return NextResponse.json({ error: 'Missing telegramId' }, { status: 400 })
    const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: BigInt(telegramId) } })
    if (!mapping) return NextResponse.json({ linked: false })
    let parkName: string | null = null
    if (mapping.activeParkId) {
        const park = await getYandexConnectionCredentialsV1(undefined, mapping.activeParkId)
        parkName = park?.name || mapping.activeParkId
    }
    return NextResponse.json({ linked: true, activeParkId: mapping.activeParkId || null, parkName })
}

async function handlePollDriverAction(payload: any) {
    const { taskId, telegramId } = payload || {}
    if (!taskId || !telegramId) {
        return NextResponse.json({ ok: false, error: 'Missing taskId or telegramId' }, { status: 400 })
    }
    const telegramIdBigInt = BigInt(telegramId)
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: telegramIdBigInt },
    })
    if (!mapping?.driverId) {
        return NextResponse.json({ ok: false, error: 'NOT_LINKED' }, { status: 404 })
    }
    const authorityFailure = await requireCurrentBotDriverAuthority(payload, {
        driverId: mapping.driverId,
        telegramId: telegramIdBigInt,
    })
    if (authorityFailure) return authorityFailure

    let scraperState: any
    try {
        const res = await providerBound(fetch(`${SCRAPER_URL}/api/driver-actions/${taskId}`))
        scraperState = await providerBound(res.json())
        if (!res.ok) {
            return NextResponse.json({ ok: false, error: scraperState?.error || `scraper ${res.status}` })
        }
    } catch (e: any) {
        return NextResponse.json({ ok: false, error: `scraper unreachable: ${e.message}` })
    }

    // Mirror state into DriverAction row (best-effort — race with parallel polls is fine).
    if (scraperState.status && scraperState.status !== 'PENDING') {
        const mutationAuthorityFailure = await requireCurrentBotDriverAuthority(payload, {
            driverId: mapping.driverId,
            telegramId: telegramIdBigInt,
        })
        if (mutationAuthorityFailure) return mutationAuthorityFailure
        await mirrorDriverActionResultV1({
            contract: MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1,
            scraperTaskId: taskId,
            status: scraperState.status,
            result: scraperState.result ?? undefined,
            errorMessage: scraperState.errorMessage ?? null,
            shortOrderId: scraperState.result?.shortOrderId ?? undefined,
            orderId: scraperState.result?.orderLongId ?? undefined,
            completedAt: new Date(),
        }).catch(() => {})
    }

    return NextResponse.json({
        ok: true,
        taskId,
        status: scraperState.status,
        result: scraperState.result || null,
        errorMessage: scraperState.errorMessage || null,
    })
}
