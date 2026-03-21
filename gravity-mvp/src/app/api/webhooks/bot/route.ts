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

    try {
        const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
        if (connection) {
            const headers: Record<string, string> = {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'X-Park-ID': connection.parkId,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json'
            }

            // Use v2 API (same as CRM UI) — reliably returns car_id
            const v2Url = `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${mapping.driverId}`
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
        if (!res.ok) break
        const data = await res.json()
        const cars: any[] = data.cars || []
        const found = cars.find((c: any) => c.id === carId)
        if (found) {
            return { brand: found.brand, model: found.model, plate: found.number, color: found.color, year: found.year }
        }
        if (page * PAGE + cars.length >= (data.total || 0)) break
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

    // 1. Try to auto-link by phone via Yandex API
    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })

    if (connection) {
        try {
            // Normalize phone: strip + and spaces
            const normalizedPhone = phone.replace(/[\s+\-()]/g, '')

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

            if (yandexRes.ok) {
                const yandexData = await yandexRes.json()
                const profiles = yandexData.driver_profiles || []

                // Find a profile whose phone matches
                const matched = profiles.find((p: any) => {
                    const phones: string[] = p.driver_profile.phones || []
                    return phones.some((ph: string) => ph.replace(/[\s+\-()]/g, '').includes(normalizedPhone) || normalizedPhone.includes(ph.replace(/[\s+\-()]/g, '')))
                })

                if (matched) {
                    const driverId = matched.driver_profile.id
                    const driverName = `${matched.driver_profile.first_name || ''} ${matched.driver_profile.last_name || ''}`.trim()

                    // Auto-link in DB
                    await prisma.driverTelegram.upsert({
                        where: { driverId },
                        update: { telegramId: BigInt(telegramId), username: username || null },
                        create: { driverId, telegramId: BigInt(telegramId), username: username || null }
                    })

                    console.log(`[Webhook] Auto-linked TG ${telegramId} → driver ${driverId} (${driverName})`)

                    // Notify the driver about successful link
                    await notifyDriverLinked(telegramId.toString(), driverName)

                    return NextResponse.json({ success: true, autoLinked: true, driverName })
                }
            }
        } catch (err: any) {
            console.error('[Webhook] Auto-link attempt failed:', err.message)
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
    const { platePrefix } = payload
    if (!platePrefix || platePrefix.length < 3) {
        return NextResponse.json({ error: 'platePrefix must be at least 3 characters' }, { status: 400 })
    }

    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
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

    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } })
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
