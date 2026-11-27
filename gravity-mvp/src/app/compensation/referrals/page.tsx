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
    // All Cash manager capabilities, including person lookup, require the
    // verified Staff Session already admitted by managerSession().
    const lookupAvailable = session.ok && enabled
    const staff = lookupAvailable ? await resolveCashStaffAuthorityV1() : null
    const writesAvailable = staff !== null && staff.ok
    const writesRefusal = staff !== null && !staff.ok ? staff.refusal : 'staff_session_unavailable'

    return (
        <div className="p-6 max-w-3xl">
            <Link href="/compensation" className="text-[13px] text-primary">← Компенсации</Link>
            <h1 className="mt-2 text-lg font-semibold text-foreground mb-1">Реферальная программа</h1>
            <p className="text-sm text-muted mb-6">
                Кто кого пригласил и у кого есть бессрочный доступ к компенсации наличных. Это два отдельных действия.
            </p>
            {!session.ok && <p className="text-sm text-muted">{refusalText(session.refusal)}</p>}
            {session.ok && !enabled && <p className="text-sm text-muted">{refusalText('disabled')}</p>}
            {session.ok && enabled && !lookupAvailable && (
                <p className="rounded-xl border border-border bg-surface p-4 text-[15px] text-foreground">
                    Войдите через Staff Session, чтобы открыть инструменты Cash.
                </p>
            )}
            {lookupAvailable && <ReferralManager writesAvailable={writesAvailable} writesRefusal={writesRefusal} />}
        </div>
    )
}
