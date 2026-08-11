import { describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    getDriverActiveTasks: vi.fn(),
}))

vi.mock('@/app/tasks/actions', () => operations)

import { getDriverActiveTasksV1 } from './task-query'

describe('Work Management public task query', () => {
    it('exposes only the active-driver task query', () => {
        expect(getDriverActiveTasksV1).toBe(operations.getDriverActiveTasks)
    })
})
