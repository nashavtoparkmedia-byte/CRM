import Link from 'next/link'

import { cashReferralManagerEnabledV1 } from '@/modules/fleet-operations/public/v1'

import { managerSession } from '../manager-data'
import ReferralManager from './ReferralManager'
import { resolveCashStaffAuthorityV1 } from './referral-data'
import { refusalText } from './view'

export const dynamic = 'force-dynamic'

export default async function CompensationReferralsPage() {
    const session = await managerSession()
    const enabled = cashReferralManagerEnabledV1()
    const writesAvailable = session.ok && enabled && (await resolveCashStaffAuthorityV1()).ok

    return (
        <div className="p-6 max-w-3xl">
            <Link href="/compensation" className="text-[13px] text-primary">← Компенсации</Link>
            <h1 className="mt-2 text-lg font-semibold text-foreground mb-1">Реферальная программа</h1>
            <p className="text-sm text-muted mb-6">
                Кто кого пригласил и у кого есть бессрочный доступ к компенсации наличных. Это два отдельных действия.
            </p>
            {!session.ok && <p className="text-sm text-muted">{refusalText(session.refusal)}</p>}
            {session.ok && !enabled && <p className="text-sm text-muted">{refusalText('disabled')}</p>}
            {session.ok && enabled && <ReferralManager writesAvailable={writesAvailable} />}
        </div>
    )
}
