/**
 * Who a monetary manager action is attributed to.
 *
 * C1 records the acting principal on every authorization, settlement and audit
 * row, so a shared label like "manager" would make the money trail unusable:
 * every approval in the park would look like the same person did it. The
 * principal therefore comes from the signed-in CRM user and from nowhere else.
 *
 * Nothing here accepts a principal from a caller. The only input is the
 * identity the session already proved, and an unproven session yields no
 * principal at all rather than a weaker one.
 */

/** The signed-in CRM user, exactly as identity-access reports it. */
export interface AuthenticatedCrmUserV1 {
    id: string
    firstName: string
    lastName: string
    role: string
    status: string
}

export const MANAGER_PRINCIPAL_REFUSALS_V1 = [
    'not_authenticated',
    'user_disabled',
    'user_identity_incomplete',
] as const

export type ManagerPrincipalRefusalV1 = typeof MANAGER_PRINCIPAL_REFUSALS_V1[number]

export interface ResolvedManagerPrincipalV1 {
    /** Stable id C1 stores as the acting principal. */
    principalId: string
    /** Human label for the audit trail; never used for identity. */
    operatorLabel: string
}

export type ManagerPrincipalResolutionV1 =
    | { resolved: true; principal: ResolvedManagerPrincipalV1 }
    | { resolved: false; refusal: ManagerPrincipalRefusalV1 }

/** The one status that may act. Anything else is not an active account. */
const ACTIVE_STATUS = 'Активен'

/**
 * Resolves the acting principal, failing closed.
 *
 * The id is namespaced so a compensation audit row can never be confused with
 * a principal minted by another subsystem that happens to use the same
 * identifier space.
 */
export function resolveManagerPrincipalV1(
    user: AuthenticatedCrmUserV1 | null | undefined,
): ManagerPrincipalResolutionV1 {
    if (!user) return { resolved: false, refusal: 'not_authenticated' }

    const id = typeof user.id === 'string' ? user.id.trim() : ''
    if (id === '') return { resolved: false, refusal: 'user_identity_incomplete' }

    if (user.status !== ACTIVE_STATUS) return { resolved: false, refusal: 'user_disabled' }

    const name = [user.firstName, user.lastName]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter((part) => part !== '')
        .join(' ')

    return {
        resolved: true,
        principal: {
            principalId: `crm_user:${id}`,
            // A missing name must not erase who acted, so the id carries the
            // label when there is nothing better to show.
            operatorLabel: name === '' ? `crm_user:${id}` : name,
        },
    }
}
