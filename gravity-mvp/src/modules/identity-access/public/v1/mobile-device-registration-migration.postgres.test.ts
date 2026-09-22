// @vitest-environment node
/**
 * Isolated-PostgreSQL proof for the MobileDeviceRegistration migration.
 *
 * The migration is expand-only: one new table with two unique indexes and one
 * eligibility index. What has to be established is the exact shape, that the
 * two uniqueness invariants the registration rules rely on are enforced by the
 * database itself, that a NULL token (awaiting or revoked) is not a binding,
 * and that nothing references or is referenced by another table.
 *
 * Runs only against a disposable database named by
 * MOBILE_PUSH_TEST_DATABASE_URL (DATABASE_URL must name the same database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'

const DATABASE = process.env.MOBILE_PUSH_TEST_DATABASE_URL
const proof = DATABASE ? describe.sequential : describe.skip
const PREFIX = `mig${Date.now().toString(36)}`

let database: PrismaClient

function row(suffix: string, token: string | null) {
    const now = new Date()
    return {
        deviceId: `${PREFIX}-${suffix}`,
        fcmToken: token,
        credentialSubject: 'mobile',
        runtimeOperatorId: 'u1',
        sessionBindingId: 'a'.repeat(64),
        sessionIssuedAt: now,
        sessionExpiresAt: new Date(now.getTime() + 3600_000),
        sessionRevocationEpoch: '0',
        credentialKeyId: '0123456789abcdef',
        lastSeenAt: now,
    }
}

proof('MobileDeviceRegistration migration on real PostgreSQL', () => {
    beforeAll(async () => {
        if (process.env.DATABASE_URL !== DATABASE) throw new Error('DATABASE_URL must equal MOBILE_PUSH_TEST_DATABASE_URL')
        database = new PrismaClient()
        await database.$connect()
    })
    beforeEach(async () => {
        await database.mobileDeviceRegistration.deleteMany({ where: { deviceId: { startsWith: PREFIX } } })
    })
    afterAll(async () => {
        await database.mobileDeviceRegistration.deleteMany({ where: { deviceId: { startsWith: PREFIX } } })
        await database.$disconnect()
    })

    it('creates exactly the declared columns, nullable only where the design says', async () => {
        const columns = await database.$queryRawUnsafe<Array<{ column_name: string, is_nullable: string, data_type: string }>>(
            `SELECT column_name, is_nullable, data_type FROM information_schema.columns
             WHERE table_name = 'MobileDeviceRegistration' ORDER BY column_name`)
        expect(columns).toEqual([
            { column_name: 'createdAt', is_nullable: 'NO', data_type: 'timestamp with time zone' },
            { column_name: 'credentialKeyId', is_nullable: 'NO', data_type: 'character' },
            { column_name: 'credentialSubject', is_nullable: 'NO', data_type: 'character varying' },
            { column_name: 'deviceId', is_nullable: 'NO', data_type: 'character varying' },
            { column_name: 'fcmToken', is_nullable: 'YES', data_type: 'character varying' },
            { column_name: 'id', is_nullable: 'NO', data_type: 'text' },
            { column_name: 'lastSeenAt', is_nullable: 'NO', data_type: 'timestamp with time zone' },
            { column_name: 'revokedAt', is_nullable: 'YES', data_type: 'timestamp with time zone' },
            { column_name: 'revokedReason', is_nullable: 'YES', data_type: 'character varying' },
            { column_name: 'runtimeOperatorId', is_nullable: 'NO', data_type: 'character varying' },
            { column_name: 'sessionBindingId', is_nullable: 'NO', data_type: 'character' },
            { column_name: 'sessionExpiresAt', is_nullable: 'NO', data_type: 'timestamp with time zone' },
            { column_name: 'sessionIssuedAt', is_nullable: 'NO', data_type: 'timestamp with time zone' },
            { column_name: 'sessionRevocationEpoch', is_nullable: 'NO', data_type: 'character varying' },
        ])
    })

    it('declares the two uniqueness invariants and the eligibility index, and no foreign key', async () => {
        const indexes = await database.$queryRawUnsafe<Array<{ indexname: string, indexdef: string }>>(
            `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'MobileDeviceRegistration' ORDER BY indexname`)
        expect(indexes.map((index) => index.indexname)).toEqual([
            'MobileDeviceRegistration_deviceId_key',
            'MobileDeviceRegistration_eligibility_idx',
            'MobileDeviceRegistration_fcmToken_key',
            'MobileDeviceRegistration_pkey',
        ])
        expect(indexes.find((index) => index.indexname === 'MobileDeviceRegistration_deviceId_key')?.indexdef).toContain('UNIQUE')
        expect(indexes.find((index) => index.indexname === 'MobileDeviceRegistration_fcmToken_key')?.indexdef).toContain('UNIQUE')
        const foreignKeys = await database.$queryRawUnsafe<Array<{ constraint_name: string }>>(
            `SELECT tc.constraint_name FROM information_schema.table_constraints tc
             JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND (tc.table_name = 'MobileDeviceRegistration' OR ccu.table_name = 'MobileDeviceRegistration')`)
        expect(foreignKeys).toEqual([])
    })

    it('refuses a second row for one device and a second device for one live token', async () => {
        await database.mobileDeviceRegistration.create({ data: row('one', `${PREFIX}_token_1_0123456789`) })
        await expect(database.mobileDeviceRegistration.create({ data: { ...row('one', `${PREFIX}_token_2_0123456789`) } })).rejects.toMatchObject({ code: 'P2002' })
        await expect(database.mobileDeviceRegistration.create({ data: row('two', `${PREFIX}_token_1_0123456789`) })).rejects.toMatchObject({ code: 'P2002' })
    })

    it('treats a NULL token as no binding: many devices may await a token at once', async () => {
        await database.mobileDeviceRegistration.create({ data: row('await-a', null) })
        await database.mobileDeviceRegistration.create({ data: row('await-b', null) })
        expect(await database.mobileDeviceRegistration.count({ where: { deviceId: { startsWith: `${PREFIX}-await` }, fcmToken: null } })).toBe(2)
    })
})
