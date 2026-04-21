import { Phone } from 'lucide-react'
import { PageContainer } from '@/components/ui/PageContainer'
import TelephonyDashboard from './TelephonyDashboard'

export const dynamic = 'force-dynamic'

export const metadata = {
    title: 'Телефония — CRM',
    description: 'Управление Android-устройствами для телефонии.',
}

export default function TelephonyPage() {
    return (
        <PageContainer>
            <div className="flex flex-col gap-8 animate-in fade-in duration-500 pb-12">
                <div className="flex items-start gap-3 border-b pb-6">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600 mt-0.5">
                        <Phone size={18} />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Телефония</h1>
                        <p className="text-muted-foreground mt-1 max-w-lg text-sm">
                            Android-устройства с SIM-картой для входящих и исходящих звонков через CRM.
                        </p>
                    </div>
                </div>

                <TelephonyDashboard />
            </div>
        </PageContainer>
    )
}
