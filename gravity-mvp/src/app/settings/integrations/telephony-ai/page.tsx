import { getTelephonyAiConfig } from '@/lib/aiCallAnalysis/config'
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/aiCallAnalysis/prompt'
import { getCurrentUser } from '@/lib/users/user-service'
import TelephonyAiClient from '@/app/settings/integrations/telephony-ai/TelephonyAiClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/telephony-ai
 *
 * Admin-only page for tuning the Whisper → Claude pipeline:
 *   – enable / disable AI scoring of calls
 *   – pick which Claude model to use (e.g. claude-sonnet-4-5 vs haiku for cost)
 *   – edit the system prompt that drives the 5-criterion rubric
 *
 * The system prompt is what Anthropic caches via cache_control:ephemeral, so
 * changes here invalidate the cache for one cycle then stabilise again.
 */
export default async function TelephonyAiSettingsPage() {
    const user = await getCurrentUser()
    const config = await getTelephonyAiConfig()
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'

    return (
        <TelephonyAiClient
            initialConfig={config}
            defaultPrompt={DEFAULT_SYSTEM_PROMPT}
            canEdit={canEdit}
        />
    )
}
