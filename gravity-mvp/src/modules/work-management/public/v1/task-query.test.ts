import { describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    getDriverActiveTasks: vi.fn(),
}))

vi.mock('@/app/tasks/actions', () => operations)

import { getDriverActiveTasksV1 } from './task-query'

describe('Work Management public task query', () => {
    it('exposes only the active-driver task query', async () => {
        const result = { tasks: [], counts: { active: 0, overdue: 0 } }
        operations.getDriverActiveTasks.mockResolvedValue(result)

        await expect(getDriverActiveTasksV1('driver-1')).resolves.toBe(result)
        expect(operations.getDriverActiveTasks).toHaveBeenCalledWith('driver-1')
    })
})
