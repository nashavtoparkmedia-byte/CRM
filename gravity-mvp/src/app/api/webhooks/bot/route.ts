import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:4000/api/bot'

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
            default:
                return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
        }
    } catch (err: any) {
        console.error('Webhook error:', err)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

// Check if a Telegram user is linked to a driver
async function handleCheckLink(payload: any) {
    const { telegramId } = payload
    if (!telegramId) {
        return NextResponse.json({ error: 'Missing telegramId' }, { status: 400 })
    }

    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: BigInt(telegramId) }
    })

    if (!mapping || !mapping.driverId) {
        return NextResponse.json({ linked: false })
    }

    let driverName = mapping.username || null
    let carInfo: string | null = null

    // Return cached car label immediately — avoids 9 sequential Yandex API calls
    // which (a) trigger 429 rate-limiting and (b) cost ~5 seconds per check_link.
    // Cache is populated below on first successful lookup.
    if (mapping.carLabel) {
        try {
            const cachedDriver = await prisma.driver.findFirst({
                where: { OR: [{ id: mapping.driverId }, { yandexDriverId: mapping.driverId }] },
                select: { fullName: true }
            })
            if (cachedDriver?.fullName) driverName = cachedDriver.fullName
        } catch { /* use username fallback */ }
        return NextResponse.json({ linked: true, driverId: mapping.driverId, driverName, carInfo: mapping.carLabel })
    }

    try {
        // Try CRM id first (manually-linked records), then Yandex contractor id
        // (records created by sync_user which stores the Yandex driver_profile.id).
        let driver = await prisma.driver.findUnique({
            where: { id: mapping.driverId },
            select: { yandexDriverId: true, fullName: true }
        })
        if (!driver) {
            driver = await prisma.driver.findFirst({
                where: { yandexDriverId: mapping.driverId },
                select: { yandexDriverId: true, fullName: true }
            })
        }

        const yandexContractorId = driver?.yandexDriverId
        if (driver?.fullName) driverName = driver.fullName
        if (!yandexContractorId) {
            console.warn('[check_link] driver has no yandexDriverId, skipping Yandex lookup:', mapping.driverId)
            return NextResponse.json({ linked: true, driverId: mapping.driverId, driverName, carInfo })
        }

        // Use driver's activeParkId if available — otherwise fall back to any connection
        const connection = mapping.activeParkId
            ? await prisma.apiConnection.findFirst({ where: { parkId: mapping.activeParkId } })
            : await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'asc' } })
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
            const v2Res = await fetch(v2Url, { method: 'GET', headers })

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
                    const car = await findCarById(connection, carId)
                    if (car) {
                        carInfo = `${car.brand || ''} ${car.model || ''} ${car.plate || ''}`.trim()
                        console.log('[check_link] found car:', carInfo)
                        // Cache to DriverTelegram so future check_link calls skip Yandex pagination
                        await prisma.driverTelegram.update({
                            where: { id: mapping.id },
                            data: { carLabel: carInfo }
                        }).catch(() => {})
                    }
                }
            } else {
                console.error('[check_link] v2 error:', v2Res.status, await v2Res.text())
            }
        }
    } catch (err: any) {
        console.error('[check_link] Failed to fetch driver/car info:', err.message)
    }

    return NextResponse.json({ linked: true, driverId: mapping.driverId, driverName, carInfo })
}

// Helper: find car by ID using paginated cars/list (same logic as getCarById in actions.ts)
async function findCarById(connection: any, carId: string) {
    const PAGE = 500
    const MAX_PAGES = 10
    const headers: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/cars/list', {
            method: 'POST',
            cache: 'no-store',
            headers,
            body: JSON.stringify({
                query: { park: { id: connection.parkId } },
                fields: { car: ['id', 'brand', 'model', 'color', 'year', 'number', 'status'] },
                limit: PAGE,
                offset: page * PAGE
            })
        })
        // 429 = rate-limited; other errors abort
        if (!res.ok) {
            console.warn('[findCarById] Yandex status', res.status, 'on page', page)
            break
        }
        const data = await res.json()
        const cars: any[] = data.cars || []
        const found = cars.find((c: any) => c.id === carId)
        if (found) {
            return { brand: found.brand, model: found.model, plate: found.number, color: found.color, year: found.year }
        }
        // Use ?? null to distinguish "total=0" from "total missing"
        const total: number | null = data.total ?? null
        if (total !== null && page * PAGE + cars.length >= total) break
        if (total === null && cars.length < PAGE) break // last page (no total field)
    }
    return null
}

// Handle "Отправить данные менеджеру" from bot — try auto-link by phone, fallback to manual
async function handleSyncUser(payload: any) {
    const { telegramId, username, phone } = payload

    if (!telegramId || !phone) {
        return NextResponse.json({ error: 'Missing telegramId or phone' }, { status: 400 })
    }

    console.log(`[Webhook] sync_user: TG ${telegramId}, Phone ${phone}`)

    // 1. Try to auto-link by phone via Yandex API — search ALL parks
    const connections = await prisma.apiConnection.findMany({ orderBy: { createdAt: 'asc' } })
    const normalizedPhone = phone.replace(/[\s+\-()]/g, '')

    for (const connection of connections) {
        try {
            const yandexRes = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
                method: 'POST',
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: { park: { id: connection.parkId }, text: phone },
                    fields: { driver_profile: ['id', 'first_name', 'last_name', 'phones'], car: [], account: [], current_status: ['status'] },
                    limit: 5,
                    offset: 0
                })
            })

            if (!yandexRes.ok) continue
            const yandexData = await yandexRes.json()
            const profiles = yandexData.driver_profiles || []

            const matched = profiles.find((p: any) => {
                const phones: string[] = p.driver_profile.phones || []
                return phones.some((ph: string) => ph.replace(/[\s+\-()]/g, '').includes(normalizedPhone) || normalizedPhone.includes(ph.replace(/[\s+\-()]/g, '')))
            })

            if (matched) {
                const yandexId = matched.driver_profile.id
                const driverName = `${matched.driver_profile.first_name || ''} ${matched.driver_profile.last_name || ''}`.trim()

                let driverId = yandexId
                try {
                    const crmDriver = await prisma.driver.findFirst({ where: { yandexDriverId: yandexId } })
                    if (crmDriver) driverId = crmDriver.id
                } catch { /* keep yandexId as fallback */ }

                await prisma.driverTelegram.upsert({
                    where: { driverId },
                    update: { telegramId: BigInt(telegramId), username: username || null, activeParkId: connection.parkId },
                    create: { driverId, telegramId: BigInt(telegramId), username: username || null, activeParkId: connection.parkId }
                })

                console.log(`[Webhook] Auto-linked TG ${telegramId} → driver ${driverId} (${driverName}) park=${connection.name || connection.parkId}`)
                await notifyDriverLinked(telegramId.toString(), driverName)
                return NextResponse.json({ success: true, autoLinked: true, driverName, parkName: connection.name || connection.parkId })
            }
        } catch (err: any) {
            console.error(`[Webhook] Auto-link failed for park ${connection.parkId}:`, err.message)
        }
    }

    // 2. Fallback: save as an unlinked message for manual manager review
    await prisma.botChatMessage.create({
        data: {
            telegramId: BigInt(telegramId),
            text: `[Запрос привязки] Телефон: ${phone}, @${username || 'нет'}`,
            direction: 'INCOMING',
            driverId: null
        }
    })

    return NextResponse.json({ success: true, autoLinked: false, message: 'Pending manual link by manager' })
}

// Called by TelegramLinkClient or TelegramManualLinkClient when manager links a driver
// This sends a Telegram notification to the driver via the bot API
export async function notifyDriverLinked(telegramId: string, driverName: string) {
    try {
        const message = `✅ Ваш профиль водителя успешно привязан к Telegram!\n\nВодитель: *${driverName}*\n\nТеперь вы можете использовать кнопку «💳 Управление лимитом» в меню бота.`
        const response = await fetch(`${BOT_API_URL}/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: telegramId, text: message })
        })
        if (!response.ok) {
            console.error('[notifyDriverLinked] Bot API error:', await response.text())
        }
    } catch (err: any) {
        console.error('[notifyDriverLinked] Error:', err.message)
    }
}

async function handleChangeLimit(payload: any) {
    const { telegramId, limitValue } = payload

    if (!telegramId || limitValue === undefined || limitValue < 1) {
        return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
    }

    // 1. Find the driver mapping
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: BigInt(telegramId) }
    })

    if (!mapping) {
        return NextResponse.json({ error: 'NOT_LINKED', message: 'Driver not linked to this Telegram ID' }, { status: 404 })
    }

    // 2. Fetch the active Yandex API connection
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' }
    })

    if (!connection) {
        return NextResponse.json({ error: 'No active Yandex API connection in CRM' }, { status: 500 })
    }

    // 3. Fetch driver data from /v1/parks/driver-profiles/list (supported endpoint)
    //    to build the person+account body required by PUT /v2/parks/contractors/driver-profile
    const yandexUrl = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${mapping.driverId}`
    const yandexAuthHeaders: Record<string, string> = {
        'X-Client-ID': connection.clid,
        'X-Api-Key': connection.apiKey,
        'X-Park-ID': connection.parkId,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json'
    }

    const safeJson = async (res: Response) => {
        const text = await res.text()
        console.log(`[safeJson] status=${res.status} ok=${res.ok} body_length=${text.length} body_preview="${text.substring(0, 100)}"`)
        try {
            return { ok: res.ok, status: res.status, data: JSON.parse(text) }
        } catch { return { ok: res.ok, status: res.status, data: { raw: text.substring(0, 300) } } }
    }

    try {
        // Step 3a: GET current contractor profile (returns exact structure needed for PUT)
        const contractorUrl = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${mapping.driverId}`
        console.log(`[changeLimit] GET contractor profile: ${contractorUrl}`)
        const { ok: getOk, status: getStatus, data: currentProfile } = await safeJson(await fetch(contractorUrl, {
            method: 'GET',
            headers: yandexAuthHeaders
        }))
        console.log(`[changeLimit] GET Response ${getStatus}:`, JSON.stringify(currentProfile).substring(0, 500))

        if (!getOk) {
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
        const { ok: putOk, status: putStatus, data: putData } = await safeJson(await fetch(contractorUrl, {
            method: 'PUT',
            headers: yandexAuthHeaders,
            body: JSON.stringify(putBody)
        }))
        console.log(`[changeLimit] PUT Response ${putStatus}:`, JSON.stringify(putData).substring(0, 300))

        if (!putOk) {
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
    let connection = null
    if (telegramId) {
        const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: BigInt(telegramId) } })
        if (mapping?.activeParkId) {
            connection = await prisma.apiConnection.findFirst({ where: { parkId: mapping.activeParkId } })
        }
    }
    if (!connection) connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'asc' } })
    if (!connection) return NextResponse.json({ error: 'No Yandex connection' }, { status: 503 })

    const prefix = platePrefix.toUpperCase().replace(/\s/g, '')
    const matches: any[] = []
    const PAGE = 500

    try {
        for (let page = 0; page < 10; page++) {
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
                })
            })
            if (!res.ok) break
            const data = await res.json()
            const cars: any[] = data.cars || []

            for (const c of cars) {
                const plate = (c.number || '').toUpperCase().replace(/\s/g, '')
                if (plate.startsWith(prefix)) {
                    matches.push({ id: c.id, brand: c.brand, model: c.model, plate: c.number, year: c.year, color: c.color })
                    if (matches.length >= 5) break // Max 5 results
                }
            }

            if (matches.length >= 5 || page * PAGE + cars.length >= (data.total || 0)) break
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

    const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: BigInt(telegramId) } })
    if (!mapping?.driverId) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 })

    const connection = mapping.activeParkId
        ? await prisma.apiConnection.findFirst({ where: { parkId: mapping.activeParkId } })
        : await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'asc' } })
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
        const contractorUrl = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${mapping.driverId}`
        const { ok: getOk, data: profile } = await safeJson(await fetch(contractorUrl, { method: 'GET', headers }))
        if (!getOk) return NextResponse.json({ error: 'Failed to fetch driver profile', details: profile }, { status: 502 })

        const putBody = { ...profile, car_id: carId }
        const { ok: putOk, status: putStatus, data: putData } = await safeJson(await fetch(contractorUrl, {
            method: 'PUT', headers, body: JSON.stringify(putBody)
        }))
        console.log(`[update_driver_car] PUT ${putStatus}:`, JSON.stringify(putData).substring(0, 200))

        if (!putOk) return NextResponse.json({ error: `Yandex error ${putStatus}`, details: putData }, { status: 502 })
        return NextResponse.json({ success: true, newCarId: carId })
    } catch (err: any) {
        console.error('[update_driver_car] Error:', err.message)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Driver-actions bridge — proxies "Цена / Завершить / Отменить" between
// TG bot and yandex-fleet-scraper. Resolves telegramId → Driver →
// yandexDriverId, persists a DriverAction audit row, enqueues a scraper task,
// returns taskId so the bot can poll.
// ────────────────────────────────────────────────────────────────────────────

const SCRAPER_URL = process.env.YANDEX_FLEET_SCRAPER_URL || 'http://localhost:3003'
const DRIVER_ACTIONS_PARK_ID = process.env.DRIVER_ACTIONS_PARK_ID ||
    '45e30e9d6b824c608e5d28719cb19a6e' // Наш Автопарк / Екатеринбург (new UI)

type DriverActionKind = 'GET_PRICE' | 'COMPLETE_ORDER' | 'CANCEL_ORDER'

async function handleDriverAction(payload: any, kind: DriverActionKind) {
    const { telegramId, reason } = payload || {}
    if (!telegramId) {
        return NextResponse.json({ ok: false, error: 'Missing telegramId' }, { status: 400 })
    }

    // 1. Resolve telegram → driver → yandexDriverId
    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: BigInt(telegramId) }
    })
    if (!mapping?.driverId) {
        return NextResponse.json({
            ok: false,
            error: 'NOT_LINKED',
            message: 'Профиль не привязан. Нажмите «Мой автомобиль» и поделитесь номером.',
        })
    }
    let driver = await prisma.driver.findUnique({
        where: { id: mapping.driverId },
        select: { id: true, fullName: true, yandexDriverId: true },
    })
    if (!driver) {
        driver = await prisma.driver.findFirst({
            where: { yandexDriverId: mapping.driverId },
            select: { id: true, fullName: true, yandexDriverId: true },
        })
    }
    if (!driver?.yandexDriverId) {
        // Audit even when we can't proceed — useful for support.
        await prisma.driverAction.create({
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

    // 2a. For GET_PRICE — query fleet API directly, no scraper needed
    if (kind === 'GET_PRICE') {
        const conn = mapping.activeParkId
            ? await prisma.apiConnection.findFirst({ where: { parkId: mapping.activeParkId } })
            : await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
        if (conn) {
            try {
                const from = new Date(Date.now() - 2 * 86400_000).toISOString()
                const to   = new Date(Date.now() + 3600_000).toISOString()
                const apiRes = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/orders/list', {
                    method: 'POST',
                    headers: {
                        'X-Client-ID': conn.clid,
                        'X-Api-Key': conn.apiKey,
                        'Accept-Language': 'ru',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        query: {
                            park: {
                                id: conn.parkId,
                                order: { booked_at: { from, to } },
                            },
                        },
                        limit: 50,
                    }),
                })
                if (apiRes.ok) {
                    const data = await apiRes.json()
                    const INACTIVE = ['complete', 'cancelled', 'failed']
                    const active = (data.orders || []).find((o: any) =>
                        o.driver_profile?.id === driver!.yandexDriverId &&
                        !INACTIVE.includes(o.status)
                    )
                    const action = await prisma.driverAction.create({
                        data: {
                            driverId: driver.id,
                            kind,
                            requestedBy: String(telegramId),
                            status: 'DONE',
                        },
                    })
                    if (!active) {
                        return NextResponse.json({
                            ok: true,
                            actionId: action.id,
                            status: 'DONE',
                            result: { noActiveOrder: true },
                        })
                    }
                    // Build result from fleet API data
                    const shortOrderId = active.id?.slice(-7) || ''
                    const fromAddress = active.address_from?.address || active.route?.points?.[0]?.fullname || ''
                    const toAddress   = (active.route_points || []).slice(-1)[0]?.address || active.route?.destination?.fullname || ''
                    const tariff      = active.category || active.tariff?.fullname || ''
                    const paymentMethod = (active.amenities || []).includes('creditcard') ? 'card' : (active.payment?.type || 'cash')
                    const bookedAt    = active.booked_at
                        ? new Date(active.booked_at).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit' })
                        : undefined
                    return NextResponse.json({
                        ok: true,
                        actionId: action.id,
                        status: 'DONE',
                        result: {
                            shortOrderId,
                            fromAddress,
                            toAddress,
                            tariff,
                            paymentMethod,
                            bookedAt,
                            priceRub: active.total_price?.amount ?? null,
                            orderSource: active.source || undefined,
                            parkName: conn.name || undefined,
                        },
                    })
                }
                console.warn(`[handleDriverAction] fleet API ${apiRes.status} — falling through to scraper`)
            } catch (e: any) {
                console.warn(`[handleDriverAction] fleet API error: ${e.message} — falling through to scraper`)
            }
        }
    }

    // 2b. Enqueue scraper task (COMPLETE_ORDER, CANCEL_ORDER, or fleet API fallback)
    let scraperTaskId: string | null = null
    try {
        const res = await fetch(`${SCRAPER_URL}/api/driver-actions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind,
                driverYandexId: driver.yandexDriverId,
                parkId: mapping.activeParkId || DRIVER_ACTIONS_PARK_ID,
                reason: reason || (kind === 'CANCEL_ORDER' ? 'Отменено водителем' : null),
            }),
        })
        const json = await res.json()
        if (!res.ok || !json.taskId) {
            throw new Error(json.error || `scraper ${res.status}`)
        }
        scraperTaskId = json.taskId
    } catch (e: any) {
        await prisma.driverAction.create({
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
    const action = await prisma.driverAction.create({
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
    const parks = await prisma.apiConnection.findMany({
        select: { parkId: true, name: true },
        orderBy: { createdAt: 'asc' }
    })
    return NextResponse.json({
        parks: parks.map(p => ({ parkId: p.parkId, name: p.name || p.parkId }))
    })
}

async function handleSetActivePark(payload: any) {
    const { telegramId, parkId } = payload
    if (!telegramId || !parkId) return NextResponse.json({ error: 'Missing params' }, { status: 400 })
    const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: BigInt(telegramId) } })
    if (!mapping) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 })
    const park = await prisma.apiConnection.findFirst({ where: { parkId } })
    await prisma.driverTelegram.update({ where: { id: mapping.id }, data: { activeParkId: parkId } })
    return NextResponse.json({ success: true, parkName: park?.name || parkId })
}

async function handleGetParkInfo(payload: any) {
    const { telegramId } = payload
    if (!telegramId) return NextResponse.json({ error: 'Missing telegramId' }, { status: 400 })
    const mapping = await prisma.driverTelegram.findFirst({ where: { telegramId: BigInt(telegramId) } })
    if (!mapping) return NextResponse.json({ linked: false })
    let parkName: string | null = null
    if (mapping.activeParkId) {
        const park = await prisma.apiConnection.findFirst({ where: { parkId: mapping.activeParkId } })
        parkName = park?.name || mapping.activeParkId
    }
    return NextResponse.json({ linked: true, activeParkId: mapping.activeParkId || null, parkName })
}

async function handlePollDriverAction(payload: any) {
    const { taskId } = payload || {}
    if (!taskId) return NextResponse.json({ ok: false, error: 'Missing taskId' }, { status: 400 })

    let scraperState: any
    try {
        const res = await fetch(`${SCRAPER_URL}/api/driver-actions/${taskId}`)
        scraperState = await res.json()
        if (!res.ok) {
            return NextResponse.json({ ok: false, error: scraperState?.error || `scraper ${res.status}` })
        }
    } catch (e: any) {
        return NextResponse.json({ ok: false, error: `scraper unreachable: ${e.message}` })
    }

    // Mirror state into DriverAction row (best-effort — race with parallel polls is fine).
    if (scraperState.status && scraperState.status !== 'PENDING') {
        await prisma.driverAction.updateMany({
            where: { scraperTaskId: taskId, status: 'PENDING' },
            data: {
                status: scraperState.status,
                result: scraperState.result ?? undefined,
                errorMessage: scraperState.errorMessage ?? null,
                shortOrderId: scraperState.result?.shortOrderId ?? undefined,
                orderId: scraperState.result?.orderLongId ?? undefined,
                completedAt: new Date(),
            },
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
