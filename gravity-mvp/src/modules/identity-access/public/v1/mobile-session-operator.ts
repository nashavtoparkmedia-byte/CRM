/**
 * Public surface of the BR-4 request-operator resolution. The composition
 * lives in application/ (it reads the logout barrier through internal/);
 * this path only re-exports it, so consumers keep one stable import.
 */
export {
    isMobileSessionLoggedOutV1,
    resolveCookieOperatorV1,
    resolveRequestOperatorV1,
} from '../../application/mobile-session-operator-operations'
export type { RequestOperatorV1 } from '../../application/mobile-session-operator-operations'
