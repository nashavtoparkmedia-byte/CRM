// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { useListViewStore as legacyListViewStore } from '@/store/list-view-store'
import { useTasksStore as legacyTasksStore } from '@/store/tasks-store'
import { useTaskCounts as legacyTaskCounts } from '@/store/tasks-selectors'
import { useListViewStore } from './list-view-store'
import { useTasksStore } from './task-store'
import { useTaskCounts } from './task-selectors'

beforeEach(() => {
  localStorage.clear()
  useTasksStore.setState({
    tasksById: {},
    taskIds: [],
    selectedTaskId: null,
    selectedDriverId: null,
    isHydrated: false,
  })
  useListViewStore.setState({
    activeViewIdByScenario: {},
    overridesByViewId: {},
    userPresets: [],
    controlSignalFilter: [],
  })
})

describe('Work Management client-state ownership', () => {
  it('keeps legacy imports as identity-preserving named shims', () => {
    expect(legacyTasksStore).toBe(useTasksStore)
    expect(legacyListViewStore).toBe(useListViewStore)
    expect(legacyTaskCounts).toBe(useTaskCounts)
  })

  it('preserves task selection and list-view state behavior', () => {
    useTasksStore.getState().setSelectedTask('task-1')
    useListViewStore.getState().setActiveView('churn', 'churn_control')

    expect(useTasksStore.getState().selectedTaskId).toBe('task-1')
    expect(useListViewStore.getState().activeViewIdByScenario).toEqual({
      churn: 'churn_control',
    })
  })
})
