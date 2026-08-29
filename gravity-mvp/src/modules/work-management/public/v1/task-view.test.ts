import { describe, expect, it, vi } from 'vitest'

const views = vi.hoisted(() => ({
    TaskCard: vi.fn(),
    TaskCreateModal: vi.fn(),
}))

vi.mock('@/app/tasks/components/TaskCard', () => ({ default: views.TaskCard }))
vi.mock('@/app/tasks/components/TaskCreateModal', () => ({ default: views.TaskCreateModal }))

import { WorkTaskCardV1, WorkTaskCreateModalV1 } from './task-view'

describe('Work Management public task view', () => {
    it('exposes the reviewed task card', () => {
        expect(WorkTaskCardV1).toBe(views.TaskCard)
        expect(WorkTaskCreateModalV1).toBe(views.TaskCreateModal)
    })
})
