import { getSystemHealthData } from './actions'
import SystemHealthContent from './SystemHealthContent'

export const dynamic = 'force-dynamic'

export default async function SystemHealthPage() {
    const data = await getSystemHealthData()
    return <SystemHealthContent data={data} />
}
