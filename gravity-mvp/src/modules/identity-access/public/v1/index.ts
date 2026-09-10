export { createIdentityAccessHandlerV1 } from './identity-access-handler'
export type { IdentityAccessPortV1 } from './identity-access-handler'

export { createCrmUserQueryHandlerV1 } from './crm-user-query-handler'
export type { CrmUserQueryPortV1 } from './crm-user-query-handler'
export { queryCrmUserV1 } from '../../application/crm-user-query-operations'
export {
    clearIntegrationAdminSession,
    establishIntegrationAdminSession,
    getIntegrationAdminPrincipal,
    hasIntegrationAdminAccess,
    IntegrationAdminAuthorizationError,
    isIntegrationAdminAuthenticationConfigured,
    requireIntegrationAdminAccess,
    requireIntegrationAdminPageAccess,
} from './integration-admin-auth'
export type { IntegrationAdminPrincipalV1 } from './integration-admin-auth'
export {
    isExactSameOriginMutationRequest,
    isJsonMutationRequest,
} from './mutation-request-boundary'
export {
    normalizeIntegrationAdminReturnTo,
} from './integration-admin-credentials'
