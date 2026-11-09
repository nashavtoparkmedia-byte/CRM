// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Staff Session v1 against a real, isolated PostgreSQL with the migration
 * applied: the table constraints, the no-delete and append-only triggers, and
 * that the advisory-locked check-and-set really serializes concurrent writers
 * (the R2 bootstrap window, the last credentialed Администратор). Skipped
 * unless STAFF_SESSION_TEST_DATABASE_URL names the same database as
 * DATABASE_URL, so it never runs against a shared database by accident.
 */

vi.mock('next/headers', () => ({
    cookies: async () => ({ get: () => undefined, set: () => undefined }),
    headers: async () => new Headers(),
}))

import { prisma } from '@/lib/prisma'
import { prismaStaffCredentialStoreV1 } from './staff-credential-store'
import { createStaffPasswordVerifierV1 } from './staff-session-credentials'
import {
    setStaffPasswordV1,
    staffLoginV1,
    strictUpdateUserV1,
    verifyStaffSessionTokenV1,
} from '../application/staff-session-operations'

const DATABASE = process.env.STAFF_SESSION_TEST_DATABASE_URL
const describeWithDatabase = DATABASE ? describe.sequential : describe.skip
const RUN = `ss${Date.now().toString(36)}`
const id = (name: string) => `${RUN}-${name}`
const CREATED = '2026-11-08T00:00:00Z'
const ADMIN_PASSWORD = 'first admin pass phrase'

let directory: string
let registryFile: string

function registry(records: Array<Record<string, string>>): void {
    writeFileSync(registryFile, JSON.stringify(records, null, 2))
}

const admin = (name: string) => ({ id: id(name), firstName: name, lastName: 'Test', role: 'Администратор', status: 'Активен', createdAt: CREATED })
const manager = (name: string) => ({ id: id(name), firstName: name, lastName: 'Test', role: 'Менеджер', status: 'Активен', createdAt: CREATED })

describeWithDatabase('Staff Session v1 credential store (PostgreSQL)', () => {
    beforeAll(() => {
        if (process.env.DATABASE_URL !== DATABASE) throw new Error('DATABASE_URL must equal STAFF_SESSION_TEST_DATABASE_URL')
        directory = mkdtempSync(path.join(tmpdir(), 'staff-session-pg-'))
        registryFile = path.join(directory, 'users.json')
        process.env.STAFF_SESSION_SECRET = 'staff-session-postgres-proof-key-0123456789abcdef'
        process.env.YOKO_USER_REGISTRY_FILE = registryFile
    })

    afterAll(async () => {
        rmSync(directory, { recursive: true, force: true })
        await prisma.$disconnect()
    })

    beforeEach(async () => {
        // Rows of earlier tests stay (they cannot be deleted); each test uses its own ids.
        registry([])
    })

    it('rejects a row outside the v1 shape (CHECK)', async () => {
        const verifier = await createStaffPasswordVerifierV1(ADMIN_PASSWORD)
        const base = {
            userId: id('shape'), registryCreatedAt: CREATED, algo: 'scrypt', scryptN: 32768, scryptR: 8, scryptP: 1,
            maxmemBytes: 67108864, salt: new Uint8Array(verifier.salt), hash: new Uint8Array(verifier.hash), updatedAt: new Date(), updatedBy: 'test',
        }
        for (const patch of [{ scryptN: 1024 }, { algo: 'md5' }, { salt: new Uint8Array(4) }, { registryCreatedAt: '' }, { hash: new Uint8Array(10) }]) {
            await expect(prisma.staffCredential.create({ data: { ...base, ...patch }, select: { userId: true } }), JSON.stringify(Object.keys(patch))).rejects.toThrow()
        }
        await expect(prisma.staffCredential.create({ data: base, select: { userId: true, sessionEpoch: true } })).resolves.toMatchObject({ userId: id('shape'), sessionEpoch: 0 })
    })

    it('never deletes a credential row, and the audit is append-only', async () => {
        const verifier = await createStaffPasswordVerifierV1(ADMIN_PASSWORD)
        await prisma.staffCredential.create({
            data: {
                userId: id('nodelete'), registryCreatedAt: CREATED, algo: 'scrypt', scryptN: 32768, scryptR: 8, scryptP: 1,
                maxmemBytes: 67108864, salt: new Uint8Array(verifier.salt), hash: new Uint8Array(verifier.hash), updatedAt: new Date(), updatedBy: 'test',
            },
            select: { userId: true },
        })
        await expect(prisma.staffCredential.delete({ where: { userId: id('nodelete') }, select: { userId: true } })).rejects.toThrow(/never deleted/)
        const event = await prisma.staffCredentialEvent.create({ data: { userId: id('nodelete'), kind: 'login', actor: 'test' }, select: { id: true } })
        await expect(prisma.staffCredentialEvent.update({ where: { id: event.id }, data: { actor: 'tampered' }, select: { id: true } })).rejects.toThrow(/append-only/)
        await expect(prisma.staffCredentialEvent.delete({ where: { id: event.id }, select: { id: true } })).rejects.toThrow(/append-only/)
        await expect(prisma.staffCredentialEvent.create({ data: { userId: id('nodelete'), kind: 'whatever', actor: 'test' }, select: { id: true } })).rejects.toThrow()
    })

    it('a work failure inside the locked transaction rolls the revocation back', async () => {
        const verifier = await createStaffPasswordVerifierV1(ADMIN_PASSWORD)
        await prismaStaffCredentialStoreV1.locked((tx) => tx.upsertVerifier({ userId: id('rollback'), registryCreatedAt: CREATED, verifier, actor: 'test', now: new Date() }))
        await expect(prismaStaffCredentialStoreV1.locked(async (tx) => {
            await tx.revoke(id('rollback'), 'test', new Date())
            throw new Error('abort after revoke')
        })).rejects.toThrow('abort after revoke')
        const row = await prismaStaffCredentialStoreV1.findStatus(id('rollback'))
        expect(row).toMatchObject({ revokedAt: null, sessionEpoch: 0 })
    })

    it('two concurrent bootstraps for two Администраторы: exactly one succeeds (R2 check-and-set)', async () => {
        // Close every earlier test's window first: these ids have no live administrator credential.
        registry([admin('bootA'), admin('bootB')])
        const results = await Promise.all([
            setStaffPasswordV1({ actor: { kind: 'integration_admin' }, targetUserId: id('bootA'), newPassword: ADMIN_PASSWORD }),
            setStaffPasswordV1({ actor: { kind: 'integration_admin' }, targetUserId: id('bootB'), newPassword: ADMIN_PASSWORD }),
        ])
        const succeeded = results.filter((result) => result.ok)
        expect(succeeded).toHaveLength(1)
        expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'bootstrap_closed' }])
        const live = (await prisma.staffCredential.findMany({ where: { userId: { in: [id('bootA'), id('bootB')] }, revokedAt: null }, select: { userId: true } })).length
        expect(live).toBe(1)
    })

    it('concurrent demotions cannot remove the last credentialed Администратор', async () => {
        registry([admin('lastA'), admin('lastB'), manager('lastM')])
        for (const name of ['lastA', 'lastB']) {
            const verifier = await createStaffPasswordVerifierV1(ADMIN_PASSWORD)
            await prismaStaffCredentialStoreV1.locked((tx) => tx.upsertVerifier({ userId: id(name), registryCreatedAt: CREATED, verifier, actor: 'test', now: new Date() }))
        }
        const login = async (name: string) => {
            const result = await staffLoginV1({ userId: id(name), password: ADMIN_PASSWORD, source: null })
            if (!result.ok) throw new Error(`login ${name}: ${result.reason}`)
            const verified = await verifyStaffSessionTokenV1(result.token)
            if (verified.kind !== 'valid') throw new Error('verify')
            return verified.principal
        }
        const a = await login('lastA')
        const b = await login('lastB')
        // Each demotes the other at the same time. Only one may win.
        const outcomes = await Promise.allSettled([
            strictUpdateUserV1(async () => a, id('lastB'), { status: 'Отключен' }),
            strictUpdateUserV1(async () => b, id('lastA'), { status: 'Отключен' }),
        ])
        const live = await prisma.staffCredential.findMany({ where: { userId: { in: [id('lastA'), id('lastB')] }, revokedAt: null }, select: { userId: true } })
        expect(live.length).toBeGreaterThanOrEqual(1)
        expect(outcomes.some((outcome) => outcome.status === 'rejected')).toBe(true)
    })
})
