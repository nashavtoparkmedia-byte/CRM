/**
 * The AI-intern control boundary, proved by behaviour rather than by reading
 * the source.
 *
 * Background: every `POST /messages` on the acceptance stand returned HTTP 500,
 * four out of four, each one preceded in the server log by
 * `[integration-auth] denied protected integration operation`. The messenger
 * header renders `AiInternToggle`, which reads this state on mount, and the
 * denial escaped the read as an unhandled rejection.
 *
 * These tests pin what must stay true together: the guard runs on every call,
 * a refusal reaches the caller as the contract's own state rather than as a
 * thrown Server Action, and nothing is read or written once refused. Weakening
 * the guard, or letting a refused write through, turns one of them red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    GET_AI_INTERN_STATE_QUERY_V1,
    GET_AI_INTERN_STATE_RESULT_V1,
    SET_AI_INTERN_STATE_COMMAND_V1,
    SET_AI_INTERN_STATE_RESULT_V1,
} from '../../../contracts/calling/v1'

class FakeAuthorizationError extends Error {
    constructor() {
        super('integration_admin_auth_required')
        this.name = 'IntegrationAdminAuthorizationError'
    }
}

const authorized = vi.fn<() => Promise<unknown>>()
const readState = vi.fn()
const writeState = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('../../identity-access/public/v1', () => ({
    IntegrationAdminAuthorizationError: FakeAuthorizationError,
    requireIntegrationAdminAccess: () => authorized(),
}))

// The port is mocked, not the handler, so the real handler and the real
// operation both run. Nothing here reaches Prisma or a database.
vi.mock('../public/v1/legacy-prisma-ai-intern-control-adapter', () => ({
    legacyPrismaAiInternControlPortV1: {
        getInternEnabled: () => readState(),
        setInternEnabled: (value: boolean) => writeState(value),
    },
}))

const deny = () => {
    authorized.mockRejectedValue(new FakeAuthorizationError())
}
const allow = () => {
    authorized.mockResolvedValue({ id: 'identity-access:integration-admin-session' })
}

const load = async () => await import('./ai-intern-control-operations')

describe('AI intern control: what a caller without integration-admin access gets', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        readState.mockResolvedValue(true)
        writeState.mockResolvedValue(undefined)
    })

    it('answers a refused read with the contract state for "unknown", not an exception', async () => {
        deny()
        const { getAiInternStateV1 } = await load()

        // Must not reject: a rejected Server Action is what Next.js turns into
        // the HTTP 500 that made every messenger page load a server error.
        const result = await getAiInternStateV1({ contract: GET_AI_INTERN_STATE_QUERY_V1 })

        expect(result).toEqual({ contract: GET_AI_INTERN_STATE_RESULT_V1, internEnabled: null })
    })

    it('still consults the guard on every read, and reads nothing once refused', async () => {
        deny()
        const { getAiInternStateV1 } = await load()

        await getAiInternStateV1({ contract: GET_AI_INTERN_STATE_QUERY_V1 })

        expect(authorized).toHaveBeenCalledTimes(1)
        expect(readState).not.toHaveBeenCalled()
    })

    it('still refuses the write, writes nothing, and says so in the contract', async () => {
        deny()
        const { setAiInternStateV1 } = await load()

        const result = await setAiInternStateV1({
            contract: SET_AI_INTERN_STATE_COMMAND_V1,
            enabled: true,
        })

        // saved:false is the refusal. The caller must never read it as success.
        expect(result).toEqual({ contract: SET_AI_INTERN_STATE_RESULT_V1, saved: false })
        expect(writeState).not.toHaveBeenCalled()
    })

    it('does not swallow a failure that is not an authorization denial', async () => {
        authorized.mockRejectedValue(new Error('session store unreachable'))
        const { getAiInternStateV1, setAiInternStateV1 } = await load()

        await expect(
            getAiInternStateV1({ contract: GET_AI_INTERN_STATE_QUERY_V1 }),
        ).rejects.toThrow('session store unreachable')
        await expect(
            setAiInternStateV1({ contract: SET_AI_INTERN_STATE_COMMAND_V1, enabled: true }),
        ).rejects.toThrow('session store unreachable')
    })
})

describe('AI intern control: an authorized caller is unaffected', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        readState.mockResolvedValue(true)
        writeState.mockResolvedValue(undefined)
        allow()
    })

    it('reads the real state', async () => {
        const { getAiInternStateV1 } = await load()

        const result = await getAiInternStateV1({ contract: GET_AI_INTERN_STATE_QUERY_V1 })

        expect(readState).toHaveBeenCalledTimes(1)
        expect(result).toEqual({ contract: GET_AI_INTERN_STATE_RESULT_V1, internEnabled: true })
    })

    it('performs the write and reports it saved', async () => {
        const { setAiInternStateV1 } = await load()

        const result = await setAiInternStateV1({
            contract: SET_AI_INTERN_STATE_COMMAND_V1,
            enabled: false,
        })

        expect(writeState).toHaveBeenCalledWith(false)
        expect(result).toEqual({ contract: SET_AI_INTERN_STATE_RESULT_V1, saved: true })
    })
})
