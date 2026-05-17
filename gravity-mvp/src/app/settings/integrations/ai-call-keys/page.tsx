import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/users/user-service'
import { getAiCallKeysStatus } from '@/lib/ai-call/keys-status'
import AiCallKeysClient from './AiCallKeysClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-keys
 *
 * Admin / Руководитель only — even configuration status (masks + sources)
 * is gated, mirroring the GET /api/settings/ai-call-keys endpoint auth.
 * Non-admin users get a 404 (not 403) so we don't even confirm the page
 * exists for them. The AiCallKeysClient still accepts canEdit, but at
 * this point we know the role is privileged — kept for forward-compat.
 */
export default async function AiCallKeysPage() {
    const user = await getCurrentUser()
    if (!user) notFound()
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') notFound()

    const status = await getAiCallKeysStatus()
    return <AiCallKeysClient initialStatus={status} canEdit={true} />
}
