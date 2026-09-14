import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    principal: vi.fn(),
    forceSync: vi.fn(),
    initConnection: vi.fn(),
    telegramImport: vi.fn(),
    telegramConnectionFindUnique: vi.fn(),
}))

vi.mock('@/infrastructure/whatsapp/operational-capabilities', () => ({
    forceSyncOperationalWhatsAppV1: mocks.forceSync,
    initializeOperationalWhatsAppV1: mocks.initConnection,
}))
vi.mock('@/infrastructure/telegram/operational-capabilities', () => ({
    importOperationalTelegramHistoryV1: mocks.telegramImport,
}))
vi.mock('@/lib/prisma', () => ({
    prisma: { telegramConnection: { findUnique: mocks.telegramConnectionFindUnique } },
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
    ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
    getIntegrationAdminPrincipal: mocks.principal,
}))

import { GET as forceSyncRoute } from './route'
import { GET as initConnectionRoute } from '../init-connection/route'
import { POST as telegramImportRoute } from '../tg-import/route'

function getRequest(path: string, query: string) {
    return new NextRequest(`https://crm.example/api/debug-db/${path}?${query}`, {
        headers: { host: 'crm.example' },
    })
}

function postRequest(path: string, body: Record<string, unknown>) {
    return new NextRequest(`https://crm.example/api/debug-db/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'crm.example' },
        body: JSON.stringify(body),
    })
}

describe('debug-db operational endpoints require integration admin authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.telegramConnectionFindUnique.mockResolvedValue({ id: 'tg-connection-1' })
    })

    test('an unauthorized caller cannot start a WhatsApp history sync', async () => {
        mocks.principal.mockResolvedValue(null)

        const response = await forceSyncRoute(getRequest('force-sync', 'id=wa-connection-1'))

        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toMatchObject({ error: 'DEBUG_ENDPOINT_FORBIDDEN' })
        // The capability is never reached, so no history import, and no Contact,
        // ContactIdentity, Chat or Message write can follow from this request.
        expect(mocks.forceSync).not.toHaveBeenCalled()
    })

    test('authorization is checked before the request is even parsed', async () => {
        mocks.principal.mockResolvedValue(null)

        // Without the gate this shape returns 400 'Missing id'. A 403 proves the
        // gate runs first and that the endpoint leaks no input validation detail.
        const response = await forceSyncRoute(getRequest('force-sync', ''))

        expect(response.status).toBe(403)
        expect(mocks.forceSync).not.toHaveBeenCalled()
    })

    test('an unauthorized caller cannot initialize a connection or import Telegram history', async () => {
        mocks.principal.mockResolvedValue(null)

        const initialize = await initConnectionRoute(getRequest('init-connection', 'id=wa-connection-1'))
        expect(initialize.status).toBe(403)
        expect(mocks.initConnection).not.toHaveBeenCalled()

        const importHistory = await telegramImportRoute(
            postRequest('tg-import', { connectionId: 'tg-connection-1', daysBack: 30 }),
        )
        expect(importHistory.status).toBe(403)
        expect(mocks.telegramImport).not.toHaveBeenCalled()
        expect(mocks.telegramConnectionFindUnique).not.toHaveBeenCalled()
    })

    test('an authorized integration admin still reaches the capability', async () => {
        mocks.principal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
        mocks.forceSync.mockResolvedValue(undefined)

        const response = await forceSyncRoute(getRequest('force-sync', 'id=wa-connection-1'))

        expect(response.status).toBe(200)
        expect(mocks.forceSync).toHaveBeenCalledWith('wa-connection-1')
    })
})
