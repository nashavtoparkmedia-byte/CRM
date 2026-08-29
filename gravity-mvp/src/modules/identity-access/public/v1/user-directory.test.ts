import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listUserIdentitiesV1: vi.fn(),
  queryCurrentUserV1: vi.fn(),
}))

vi.mock('./identity-actions', () => mocks)

import {
  CURRENT_USER_QUERY_V1,
  LIST_USER_IDENTITIES_QUERY_V1,
} from '@/contracts/identity-access/v1'
import { getCurrentUserIdentityV1, listUserIdentitiesV1 } from './user-directory'

beforeEach(() => vi.clearAllMocks())

describe('Identity Access user directory façade', () => {
  it('uses only the fixed current-user query and returns its projection', async () => {
    const user = {
      id: 'u1', firstName: 'Ada', lastName: 'Lovelace', role: 'Администратор',
      status: 'Активен', createdAt: '2026-08-11T00:00:00.000Z',
    }
    mocks.queryCurrentUserV1.mockResolvedValue({ contract: 'identity_access.CurrentUserResult.v1', user })

    await expect(getCurrentUserIdentityV1()).resolves.toEqual(user)
    expect(mocks.queryCurrentUserV1).toHaveBeenCalledWith({ contract: CURRENT_USER_QUERY_V1 })
  })

  it('uses only the fixed list query and returns identities rather than storage rows', async () => {
    mocks.listUserIdentitiesV1.mockResolvedValue({
      contract: 'identity_access.ListUserIdentitiesResult.v1',
      users: [],
    })

    await expect(listUserIdentitiesV1()).resolves.toEqual([])
    expect(mocks.listUserIdentitiesV1).toHaveBeenCalledWith({ contract: LIST_USER_IDENTITIES_QUERY_V1 })
  })
})
