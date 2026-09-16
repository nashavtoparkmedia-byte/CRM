import { listCompensationApplications } from './actions'
import CompensationApplicationList from './CompensationApplicationList'

export const dynamic = 'force-dynamic'

export default async function CompensationPage() {
    const applications = await listCompensationApplications()

    return (
        <div className="p-6 max-w-5xl">
            <h1 className="text-lg font-semibold text-foreground mb-1">Компенсации наличными</h1>
            <p className="text-sm text-muted mb-6">
                Пилот: заявки водителей на компенсацию наличных заказов. Выплата ручная.
            </p>
            <CompensationApplicationList applications={applications} />
        </div>
    )
}
