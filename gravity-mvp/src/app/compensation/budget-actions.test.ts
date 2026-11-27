import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerSession = vi.fn()
const ensureCompensationBudgetPeriodV1 = vi.fn()
const revalidatePath = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))
vi.mock('./manager-data', () => ({ managerSession: () => managerSession() }))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
    ensureCompensationBudgetPeriodV1: (input: unknown) => ensureCompensationBudgetPeriodV1(input),
}))

import { provisionCompensationBudget } from './budget-actions'

const form = (periodKey: string, limitRubles: string) => {
    const value = new FormData()
    value.set('periodKey', periodKey)
    value.set('limitRubles', limitRubles)
    return value
}

beforeEach(() => {
    vi.clearAllMocks()
    managerSession.mockResolvedValue({ ok: true, role: 'Менеджер', principal: { principalId: 'staff:1', operatorLabel: 'Менеджер' } })
    ensureCompensationBudgetPeriodV1.mockResolvedValue({ ok: true, outcome: 'created' })
})

describe('budget management action', () => {
    it('requires the verified manager session before reaching the monetary core', async () => {
        managerSession.mockResolvedValue({ ok: false, refusal: 'not_authenticated' })
        await provisionCompensationBudget(form('2026-11', '5000'))
        expect(ensureCompensationBudgetPeriodV1).not.toHaveBeenCalled()
        expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('forwards the Owner-approved default in exact kopecks', async () => {
        await provisionCompensationBudget(form('2026-11', '5000'))
        expect(ensureCompensationBudgetPeriodV1).toHaveBeenCalledWith({ periodKey: '2026-11', limitKopecks: 500_000 })
        expect(revalidatePath).toHaveBeenCalledWith('/compensation')
    })

    it('accepts a decimal ruble amount without floating point arithmetic', async () => {
        await provisionCompensationBudget(form('2026-11', '5000,50'))
        expect(ensureCompensationBudgetPeriodV1).toHaveBeenCalledWith({ periodKey: '2026-11', limitKopecks: 500_050 })
    })

    it('ignores malformed or non-positive input', async () => {
        for (const raw of ['', '0', '-1', '1.234', '5e3']) {
            await provisionCompensationBudget(form('2026-11', raw))
        }
        expect(ensureCompensationBudgetPeriodV1).not.toHaveBeenCalled()
        expect(revalidatePath).not.toHaveBeenCalled()
    })
})
