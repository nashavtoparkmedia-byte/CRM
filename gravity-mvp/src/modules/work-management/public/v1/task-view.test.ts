import { describe, expect, it, vi } from 'vitest'

const views = vi.hoisted(() => ({
    TaskCard: vi.fn(),
}))

vi.mock('@/app/tasks/components/TaskCard', () => ({ default: views.TaskCard }))

import { WorkTaskCardV1 } from './task-view'

describe('Work Management public task view', () => {
    it('exposes the reviewed task card', () => {
        expect(WorkTaskCardV1).toBe(views.TaskCard)
    })
})
