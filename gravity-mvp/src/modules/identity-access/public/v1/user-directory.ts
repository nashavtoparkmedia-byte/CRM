'use server'

import {
  CURRENT_USER_QUERY_V1,
  LIST_USER_IDENTITIES_QUERY_V1,
  type UserIdentityV1,
} from '@/contracts/identity-access/v1'
import {
  listUserIdentitiesV1 as executeListUserIdentitiesV1,
  queryCurrentUserV1,
} from './identity-actions'

/** Fixed current-session identity query; no users.json or cookie mechanism escapes. */
export async function getCurrentUserIdentityV1(): Promise<UserIdentityV1 | null> {
  const result = await queryCurrentUserV1({ contract: CURRENT_USER_QUERY_V1 })
  return result.user
}

/** Fixed operator directory projection using the existing versioned contract. */
export async function listUserIdentitiesV1(): Promise<UserIdentityV1[]> {
  const result = await executeListUserIdentitiesV1({ contract: LIST_USER_IDENTITIES_QUERY_V1 })
  return result.users
}
