import { getCurrentUser } from '@/lib/users/user-service'
import { getAiCallKeysStatus } from '@/lib/ai-call/keys-status'
import AiCallKeysClient from './AiCallKeysClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-keys
 *
 * Admin page that shows the status of AI-call API keys (OpenAI, Yandex
 * SpeechKit) and the mock-mode toggle. Keys themselves are stored in
 * `.env` and never exposed to the browser — the page only renders
 * "configured / not configured" + last-4 mask + "test connection" button.
 *
 * For non-admins the page is still readable but the test buttons hint
 * that only admins should change .env.
 */
export default async function AiCallKeysPage() {
    const user = await getCurrentUser()
    const status = await getAiCallKeysStatus()
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'
    return <AiCallKeysClient initialStatus={status} canEdit={canEdit} />
}
