import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readChannelDeliveryErrorV1 } from './delivery-state-policy'
import {
    assertLiveRecipientAllowedV1,
    createLiveAcceptanceGuardV1,
    isLiveAcceptanceGuardActiveV1,
    isLivePeerAllowedV1,
    liveAcceptanceGuardStatusV1,
    maskLiveProviderIdV1,
    readLiveRecipientRefusalV1,
    type LiveAcceptanceGuardDependenciesV1,
    type LiveAcceptanceLaneV1,
    type LiveAcceptanceSendKindV1,
} from './live-acceptance-recipient-guard'

interface Step {
    op: 'send' | 'lookup' | 'assert' | 'peer' | 'status' | 'write_allowlist'
    content?: unknown
    kind?: string
    lane?: string
    id?: string
    at: string
    expect?: unknown
    expect_lane?: { lane: LiveAcceptanceLaneV1; sendsUsed: number }
}
interface Vector {
    name: string
    env: Record<string, string>
    allowlist: unknown
    counters?: Record<string, string>
    startup_log?: string[]
    steps: Step[]
}

const vectors = JSON.parse(readFileSync(path.join(__dirname, 'live-acceptance-recipient-guard.vectors.json'), 'utf8')) as { schema: string; cases: Vector[] }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const expandSha = (content: string) => content.replace(/__SHA256\(([^)]*)\)__/g, (_, value: string) => sha256(value))

/** An in-memory file system with the same semantics the disk adapter has (exclusive create). */
function memory(vector: Vector, clock: { now: number }) {
    const files = new Map<string, string>()
    const directories = new Set<string>()
    const allowlistFile = vector.env.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
    if (allowlistFile && vector.allowlist !== null) {
        files.set(allowlistFile, typeof vector.allowlist === 'string' ? vector.allowlist : JSON.stringify(vector.allowlist))
    }
    const counterDirectory = vector.env.YOKO_LIVE_STATE_DIR
    for (const [name, content] of Object.entries(vector.counters ?? {})) {
        files.set(path.join(counterDirectory, name), expandSha(content))
    }
    const log: string[] = []
    const dependencies: LiveAcceptanceGuardDependenciesV1 = {
        env: vector.env,
        readFile: (file) => {
            const content = files.get(file)
            if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return content
        },
        ensureDirectory: (directory) => { directories.add(directory) },
        readSlots: (directory, prefix) => [...files.entries()]
            .filter(([file]) => path.dirname(file) === directory && path.basename(file).startsWith(prefix))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, content]) => content),
        claimSlot: (file, content) => {
            if (files.has(file)) return false
            files.set(file, content)
            return true
        },
        log: (line) => { log.push(line) },
        now: () => clock.now,
    }
    return { dependencies, files, log }
}

function outcome(run: () => void): string {
    try {
        run()
        return 'allow'
    } catch (error: unknown) {
        const typed = readChannelDeliveryErrorV1(error)
        if (!typed) throw error
        expect(typed.outcome).toBe('terminal')
        return typed.code ?? 'no-code'
    }
}

describe('live-acceptance recipient guard: shared conformance vectors', () => {
    it('reads the vectors file of its own schema', () => {
        expect(vectors.schema).toBe('yoko.live-acceptance.recipient-guard-vectors.v1')
        expect(vectors.cases.length).toBeGreaterThanOrEqual(25)
    })

    for (const vector of vectors.cases) {
        it(vector.name, () => {
            const clock = { now: Date.parse(vector.steps[0]?.at ?? '2026-11-12T09:00:00.000Z') }
            const { dependencies, files, log } = memory(vector, clock)
            const guard = createLiveAcceptanceGuardV1(dependencies)
            if (vector.startup_log) expect(log).toEqual(vector.startup_log)
            for (const step of vector.steps) {
                clock.now = Date.parse(step.at)
                const lane = step.lane as LiveAcceptanceLaneV1
                if (step.op === 'write_allowlist') {
                    const target = vector.env.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
                    if (step.content === null) files.delete(target)
                    else files.set(target, typeof step.content === 'string' ? step.content : JSON.stringify(step.content))
                } else if (step.op === 'peer') {
                    expect(guard.isPeerAllowed(lane, step.id as string) ? 'allow' : 'refuse', `${step.lane} ${step.id}`).toBe(step.expect)
                } else if (step.op === 'status') {
                    const status = guard.status()
                    if (step.expect !== undefined) expect(status).toEqual(step.expect)
                    if (step.expect_lane) {
                        expect(status.mode).toBe('enforce')
                        if (status.mode === 'enforce') expect(status.lanes[step.expect_lane.lane].sendsUsed).toBe(step.expect_lane.sendsUsed)
                    }
                } else {
                    const kind = (step.op === 'assert' ? step.kind : step.op) as LiveAcceptanceSendKindV1
                    expect(outcome(() => guard.assertRecipientAllowed(lane, step.id as string, kind)), `${step.op} ${step.lane} ${step.id} at ${step.at}`).toBe(step.expect)
                }
            }
        })
    }
})

describe('live-acceptance recipient guard: behaviour beyond the vectors', () => {
    const ON = { YOKO_LIVE_ACCEPTANCE: '1', YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE: '/live/allowlist.json', YOKO_LIVE_STATE_DIR: '/live/state' }
    const allowlist = {
        schema: 'yoko.live-acceptance.recipient-allowlist.v1',
        run_id: 'LIVE-T-02',
        expires_at: '2026-11-12T18:00:00.000Z',
        min_interval_ms_per_recipient: 0,
        channels: { max: { recipients: ['90000001', '90000002'], max_sends: 3 } },
    }
    const vector = (counters?: Record<string, string>): Vector => ({ name: 'inline', env: ON, allowlist, counters, steps: [] })

    it('the process guard is off in the test process: no-op, every peer allowed, status off', () => {
        expect(isLiveAcceptanceGuardActiveV1()).toBe(false)
        expect(() => assertLiveRecipientAllowedV1('whatsapp', 'anyone', 'send')).not.toThrow()
        expect(isLivePeerAllowedV1('max', 'anyone')).toBe(true)
        expect(liveAcceptanceGuardStatusV1()).toEqual({ mode: 'off' })
    })

    it('two guard instances over one counter directory share the cap (a lost slot race recounts)', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        const first = createLiveAcceptanceGuardV1(shared.dependencies)
        const second = createLiveAcceptanceGuardV1(shared.dependencies)
        expect(outcome(() => first.assertRecipientAllowed('max', '90000001', 'send'))).toBe('allow')
        expect(outcome(() => second.assertRecipientAllowed('max', '90000002', 'send'))).toBe('allow')
        expect(outcome(() => first.assertRecipientAllowed('max', '90000002', 'send'))).toBe('allow')
        expect(outcome(() => second.assertRecipientAllowed('max', '90000001', 'send'))).toBe('LIVE_GUARD_CAP_REACHED')
        expect([...shared.files.keys()].filter((file) => file.startsWith('/live/state/')).sort()).toEqual([
            '/live/state/LIVE-T-02.max.slot-0001',
            '/live/state/LIVE-T-02.max.slot-0002',
            '/live/state/LIVE-T-02.max.slot-0003',
        ])
    })

    it('a slot taken by another instance between count and claim is never overwritten', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        const guard = createLiveAcceptanceGuardV1({
            ...shared.dependencies,
            claimSlot: (file, content) => {
                // The racing instance writes the same slot number first, once.
                if (file.endsWith('slot-0001') && !shared.files.has(file)) shared.files.set(file, `2026-11-12T08:59:59.000Z\t${sha256('90000002')}\n`)
                return shared.dependencies.claimSlot(file, content)
            },
        })
        expect(outcome(() => guard.assertRecipientAllowed('max', '90000001', 'send'))).toBe('allow')
        expect(shared.files.get('/live/state/LIVE-T-02.max.slot-0001')).toContain(sha256('90000002'))
        expect(shared.files.get('/live/state/LIVE-T-02.max.slot-0002')).toContain(sha256('90000001'))
    })

    it('a counter write failure refuses the send (fail-closed) and claims nothing', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        const guard = createLiveAcceptanceGuardV1({ ...shared.dependencies, claimSlot: () => { throw new Error('EROFS') } })
        expect(outcome(() => guard.assertRecipientAllowed('max', '90000001', 'send'))).toBe('LIVE_GUARD_COUNTER_UNAVAILABLE')
    })

    it('a slot file corrupted after startup refuses the send and reports refuse_all', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        const guard = createLiveAcceptanceGuardV1(shared.dependencies)
        shared.files.set('/live/state/LIVE-T-02.max.slot-0001', 'garbage')
        expect(outcome(() => guard.assertRecipientAllowed('max', '90000001', 'send'))).toBe('LIVE_GUARD_COUNTER_UNAVAILABLE')
        expect(guard.status()).toEqual({ mode: 'refuse_all', reason: 'LIVE_GUARD_COUNTER_UNAVAILABLE' })
    })

    it('a slot records only the time and the sha256 of the recipient, never the id', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        createLiveAcceptanceGuardV1(shared.dependencies).assertRecipientAllowed('max', '90000001', 'send')
        const slot = shared.files.get('/live/state/LIVE-T-02.max.slot-0001') as string
        expect(slot).toBe(`2026-11-12T09:00:00.000Z\t${sha256('90000001')}\n`)
        expect(slot).not.toContain('90000001')
    })

    it('the allowlist is frozen at startup: a later change never widens it and refuses everything', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        const guard = createLiveAcceptanceGuardV1(shared.dependencies)
        shared.files.set('/live/allowlist.json', JSON.stringify({ ...allowlist, channels: { max: { recipients: ['90000009'], max_sends: 3 } } }))
        expect(guard.isPeerAllowed('max', '90000009')).toBe(false)
        expect(guard.isPeerAllowed('max', '90000001')).toBe(false)
        expect(guard.status()).toEqual({ mode: 'refuse_all', reason: 'LIVE_GUARD_CONFIG_CHANGED' })
    })

    it('the startup lines carry the mode and the count only, never an id or the run id', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory(vector(), clock)
        createLiveAcceptanceGuardV1(shared.dependencies)
        expect(shared.log).toContain('YOKO_LIVE_GUARD channel=max mode=enforce entries=2')
        for (const line of shared.log) {
            expect(line).toMatch(/^YOKO_LIVE_GUARD channel=(whatsapp|max|telegram_mtproto|telegram_bot) mode=(enforce|refuse_all) entries=\d+$/)
            expect(line).not.toContain('90000001')
            expect(line).not.toContain('LIVE-T-02')
        }
    })
})

describe('live-acceptance recipient guard: helpers', () => {
    it('reads its own refusal back, and nothing else', () => {
        const clock = { now: Date.parse('2026-11-12T09:00:00.000Z') }
        const shared = memory({ name: 'x', env: { YOKO_LIVE_ACCEPTANCE: '1' }, allowlist: null, steps: [] }, clock)
        const guard = createLiveAcceptanceGuardV1(shared.dependencies)
        let caught: unknown = null
        try { guard.assertRecipientAllowed('max', '1', 'send') } catch (error) { caught = error }
        expect(readLiveRecipientRefusalV1(caught)).toBe('LIVE_GUARD_CONFIG_INVALID')
        expect(String((caught as Error).message)).not.toContain('max 1')
        expect(readLiveRecipientRefusalV1(new Error('LIVE_GUARD_NOT_LISTED'))).toBeNull()
        expect(readLiveRecipientRefusalV1(Object.assign(new Error('x'), { name: 'ChannelDeliveryErrorV1', deliveryOutcome: 'terminal', deliveryErrorCode: 'PROVIDER_REFUSED' }))).toBeNull()
        expect(readLiveRecipientRefusalV1(null)).toBeNull()
    })

    it('masks every run of five or more digits to its last four', () => {
        expect(maskLiveProviderIdV1('79161234567@c.us')).toBe('•••••••4567@c.us')
        expect(maskLiveProviderIdV1('123456789012345@lid')).toBe('•••••••••••2345@lid')
        expect(maskLiveProviderIdV1('false_79161234567@c.us_3EB0A1B2C3D4E5F60718')).toBe('false_•••••••4567@c.us_3EB0A1B2C3D4E5F•0718')
        expect(maskLiveProviderIdV1('-1007000002')).toBe('-••••••0002')
        expect(maskLiveProviderIdV1('d3000000000000abcd')).toBe('d•••••••••0000abcd')
        expect(maskLiveProviderIdV1('1234')).toBe('1234')
    })
})

describe('live-acceptance recipient guard: never in the production configuration', () => {
    const root = path.resolve(__dirname, '../../../../../..')
    const NAMES = ['YOKO_LIVE_ACCEPTANCE', 'YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE', 'YOKO_LIVE_STATE_DIR']
    const SKIP = new Set(['node_modules', '.git', '.next', '.claude'])
    function walk(directory: string, keep: (name: string) => boolean, out: string[] = []): string[] {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue
            const full = path.join(directory, entry.name)
            if (entry.isDirectory()) walk(full, keep, out)
            else if (entry.isFile() && keep(entry.name)) out.push(full)
        }
        return out
    }
    const files = [
        ...walk(path.join(root, 'deploy'), () => true),
        path.join(root, '.env.production.example'),
        ...walk(root, (name) => /^Dockerfile/.test(name)),
    ]

    it('scans the deploy tree, the production env example and every Dockerfile', () => {
        expect(files.some((file) => file.endsWith('deploy/docker-compose.production.yml'))).toBe(true)
        expect(files.some((file) => file.endsWith('.env.production.example'))).toBe(true)
        expect(files.some((file) => path.basename(file).startsWith('Dockerfile'))).toBe(true)
    })

    it('none of them names a live-acceptance variable', () => {
        const hits = files.flatMap((file) => {
            const content = readFileSync(file, 'utf8')
            return NAMES.filter((name) => content.includes(name)).map((name) => `${path.relative(root, file)}: ${name}`)
        })
        expect(hits).toEqual([])
    })
})
