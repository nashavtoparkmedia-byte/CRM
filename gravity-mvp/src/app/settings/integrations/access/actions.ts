'use server'

import { redirect } from 'next/navigation'
import {
    clearIntegrationAdminSession,
    establishIntegrationAdminSession,
    isIntegrationAdminAuthenticationConfigured,
    normalizeIntegrationAdminReturnTo,
} from '@/modules/identity-access/public/v1'

export async function signInIntegrationAdmin(formData: FormData): Promise<void> {
    const returnTo = normalizeIntegrationAdminReturnTo(formData.get('next'))
    const configured = isIntegrationAdminAuthenticationConfigured()
    const authenticated = configured && await establishIntegrationAdminSession(
        formData.get('username'),
        formData.get('password'),
    )

    if (!authenticated) {
        const reason = configured ? 'invalid' : 'unavailable'
        redirect(`/settings/integrations/access?error=${reason}&next=${encodeURIComponent(returnTo)}`)
    }
    redirect(returnTo)
}

export async function signOutIntegrationAdmin(): Promise<void> {
    await clearIntegrationAdminSession()
    redirect('/settings/integrations/access')
}
