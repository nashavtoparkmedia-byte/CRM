import { getCurrentUser } from '@/lib/users/user-service'
import { getAiCallKeysStatus } from '@/lib/ai-call/keys-status'
import TelephonyConnectionClient from './TelephonyConnectionClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/telephony
 *
 * Connection panel: live health of FreeSWITCH / Megafon trunk / VPN / queue,
 * plus admin-editable forms for the MultiFon SIP-trunk credentials and
 * the AI-call provider keys (OpenAI / Yandex SpeechKit). On MultiFon save
 * we rewrite megafon.xml and ESL-reload sofia so the new creds take effect
 * without a server restart. AI keys live in DB (AiProviderSetting), so the
 * key-management UI is the same one that appears under /ai-call-keys.
 *
 * AI/regulation settings live next door at /settings/integrations/telephony-ai
 * (rubric, criteria, dictionaries).
 */
export default async function TelephonyConnectionPage() {
    const user = await getCurrentUser()
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'
    const keysStatus = await getAiCallKeysStatus()

    return <TelephonyConnectionClient canEdit={canEdit} keysStatus={keysStatus} />
}
