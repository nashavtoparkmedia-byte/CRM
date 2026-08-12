export { createIdentityAccessHandlerV1 } from './identity-access-handler'
export type { IdentityAccessPortV1 } from './identity-access-handler'
import { createCrmUserQueryHandlerV1 } from './crm-user-query-handler'
import { legacyPrismaCrmUserQueryPortV1 } from './legacy-prisma-crm-user-query-adapter'

export { createCrmUserQueryHandlerV1 } from './crm-user-query-handler'
export type { CrmUserQueryPortV1 } from './crm-user-query-handler'
export const queryCrmUserV1 = createCrmUserQueryHandlerV1(legacyPrismaCrmUserQueryPortV1)
export {
    clearIntegrationAdminSession,
    establishIntegrationAdminSession,
    hasIntegrationAdminAccess,
    IntegrationAdminAuthorizationError,
    isIntegrationAdminAuthenticationConfigured,
    requireIntegrationAdminAccess,
    requireIntegrationAdminPageAccess,
} from './integration-admin-auth'
export {
    normalizeIntegrationAdminReturnTo,
} from './integration-admin-credentials'
