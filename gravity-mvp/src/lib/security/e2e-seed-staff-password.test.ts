// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

/**
 * C1 (Security, docs/design/mobile-personal-signin-v1.md §3 item 4): the E2E
 * password seed drives the integration-admin bootstrap with a public CI
 * password, and a production CRM before its first bootstrap has that window
 * open too. So it refuses every base URL that is not loopback before it sends
 * anything, and nothing in deploy/ or the operations docs refers to it.
 */

const seed = await import('../../../scripts/e2e-seed-staff-password.mjs') as unknown as {
    loopbackBaseUrlV1(value: string): URL | Error
    seedStaffPasswordV1(input: { base: string, userId: string, appRoot: string, env?: Record<string, string> }): Promise<unknown>
}

const ENV = { ADMIN_USER: 'e2e-admin', ADMIN_PASS: 'e2e admin pass phrase', E2E_STAFF_PASSWORD: 'e2e staff pass phrase' }

afterEach(() => {
    vi.restoreAllMocks()
})

describe('the E2E password seed runs only against a loopback CRM', () => {
    test('accepts plain loopback origins only', () => {
        for (const base of ['http://127.0.0.1:3013', 'http://localhost:3013', 'http://[::1]:3013', 'https://localhost']) {
            expect(seed.loopbackBaseUrlV1(base), base).toBeInstanceOf(URL)
        }
        for (const base of [
            'https://yokoone.ru',
            'http://10.0.0.5:3002',
            'http://192.168.1.10:3002',
            'http://gravity-mvp:3002',
            'http://127.0.0.1.nip.io:3013',
            'http://localhost.yokoone.ru',
            'http://user:pass@127.0.0.1:3013',
            'http://127.0.0.1:3013/users',
            'file:///etc/passwd',
            'not a url',
            '',
        ]) {
            expect(seed.loopbackBaseUrlV1(base), base).toBeInstanceOf(Error)
        }
    })

    test('a non-loopback base URL is refused before any request is sent', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('no request may be sent') })
        for (const base of ['https://yokoone.ru', 'http://10.0.0.5:3002', 'http://gravity-mvp:3002']) {
            await expect(seed.seedStaffPasswordV1({ base, userId: 'u1', appRoot: process.cwd(), env: ENV })).rejects.toThrow(/loopback/)
        }
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('nothing in deploy/ or the operations docs refers to the seed', () => {
        const repository = path.resolve(process.cwd(), '..')
        const walk = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
            const file = path.join(directory, name)
            return statSync(file).isDirectory() ? walk(file) : [file]
        })
        const files = [...walk(path.join(repository, 'deploy')), ...walk(path.join(repository, 'docs/operations'))]
        expect(files.length).toBeGreaterThan(0)
        const referring = files.filter((file) => readFileSync(file, 'utf8').includes('e2e-seed-staff-password'))
        expect(referring).toEqual([])
    })
})
