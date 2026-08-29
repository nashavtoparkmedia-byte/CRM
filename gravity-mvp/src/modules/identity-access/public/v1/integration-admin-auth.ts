import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
    getIntegrationAdminCredentialConfig,
    INTEGRATION_ADMIN_SESSION_COOKIE,
    INTEGRATION_ADMIN_SESSION_TTL_SECONDS,
    issueIntegrationAdminSession,
    normalizeIntegrationAdminReturnTo,
    verifyIntegrationAdminCredentials,
    verifyIntegrationAdminSession,
} from './integration-admin-credentials'

export class IntegrationAdminAuthorizationError extends Error {
    constructor() {
        super('integration_admin_auth_required')
        this.name = 'IntegrationAdminAuthorizationError'
    }
}

export function isIntegrationAdminAuthenticationConfigured(): boolean {
    return getIntegrationAdminCredentialConfig() !== null
}

export async function hasIntegrationAdminAccess(): Promise<boolean> {
    const cookieStore = await cookies()
    return verifyIntegrationAdminSession(
        cookieStore.get(INTEGRATION_ADMIN_SESSION_COOKIE)?.value,
    )
}

/**
 * Real server-side authorization boundary for integration credentials and
 * provider login ceremonies. It intentionally does not inspect crm_user_id:
 * that cookie is an unsigned UI identity selector, not authentication.
 */
export async function requireIntegrationAdminAccess(): Promise<void> {
    if (await hasIntegrationAdminAccess()) return
    console.warn('[integration-auth] denied protected integration operation')
    throw new IntegrationAdminAuthorizationError()
}

export async function requireIntegrationAdminPageAccess(returnTo: string): Promise<void> {
    if (await hasIntegrationAdminAccess()) return
    const safeReturnTo = normalizeIntegrationAdminReturnTo(returnTo)
    redirect(`/settings/integrations/access?next=${encodeURIComponent(safeReturnTo)}`)
}

export async function establishIntegrationAdminSession(
    suppliedUsername: unknown,
    suppliedPassword: unknown,
): Promise<boolean> {
    if (!verifyIntegrationAdminCredentials(suppliedUsername, suppliedPassword)) return false
    const token = issueIntegrationAdminSession()
    if (!token) return false

    const cookieStore = await cookies()
    cookieStore.set(INTEGRATION_ADMIN_SESSION_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: INTEGRATION_ADMIN_SESSION_TTL_SECONDS,
    })
    return true
}

export async function clearIntegrationAdminSession(): Promise<void> {
    const cookieStore = await cookies()
    cookieStore.set(INTEGRATION_ADMIN_SESSION_COOKIE, '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 0,
    })
}
