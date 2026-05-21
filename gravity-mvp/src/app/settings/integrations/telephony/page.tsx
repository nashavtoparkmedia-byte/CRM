import { getCurrentUser } from '@/lib/users/user-service'
import TelephonyConnectionClient from './TelephonyConnectionClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/telephony
 *
 * Connection panel: live health of FreeSWITCH / Megafon trunk / VPN / queue,
 * plus an admin-editable form for the MultiFon SIP-trunk credentials
 * (gateway username, password, realm, proxy). On save we rewrite the
 * megafon.xml gateway config and ESL-reload sofia so the new creds
 * take effect without a server restart.
 *
 * AI/regulation settings live next door at /settings/integrations/telephony-ai
 * (rubric, criteria, dictionaries).
 */
export default async function TelephonyConnectionPage() {
    const user = await getCurrentUser()
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'

    return <TelephonyConnectionClient canEdit={canEdit} />
}
