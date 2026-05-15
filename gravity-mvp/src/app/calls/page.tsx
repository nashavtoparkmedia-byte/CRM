import { Phone } from 'lucide-react'
import CallsList from '@/components/sip/CallsList'

export const dynamic = 'force-dynamic'

export default function CallsPage() {
    return (
        <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full animate-in fade-in duration-500">
            <div className="flex items-center gap-3">
                <Phone className="h-6 w-6 text-primary"/>
                <h1 className="text-2xl font-bold text-foreground">Звонки</h1>
            </div>
            <div className="rounded-2xl border bg-card p-6 shadow-sm">
                <CallsList limit={200}/>
            </div>
        </div>
    )
}
