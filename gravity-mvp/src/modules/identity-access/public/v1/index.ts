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
    normalizeIntegrationAdminReturnTo,
} from './integration-admin-credentials'
export {
    clearMobileSessionV1,
    establishMobileSessionV1,
    getMobileSessionPrincipalV1,
    hasMobileSessionV1,
    isMobileLaneConfigured,
    MobileSessionRequiredError,
    requireMobileSessionV1,
    writeDerivedUiIdentityCookie,
} from './mobile-session-auth'
export type { MobileLoginFailure } from './mobile-session-auth'
export {
    getMobileSessionRevocationEpoch,
    isMobileAccessConfigured,
    MOBILE_SESSION_COOKIE,
    MOBILE_SESSION_TTL_SECONDS,
    normalizeMobileReturnTo,
} from './mobile-session-credentials'
export type { MobileSessionPrincipalV1 } from './mobile-session-credentials'
