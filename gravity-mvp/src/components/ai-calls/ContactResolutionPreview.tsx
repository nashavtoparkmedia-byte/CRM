import { AlertCircle, CheckCircle2, Search, Users } from 'lucide-react'
import { resolvePreviewContact } from '@/lib/ai-call/contact-preview'

export function ContactResolutionPreview({ phone }: { phone: string }) {
    const result = resolvePreviewContact(phone)
    const tone = result.status === 'MATCHED'
        ? 'border-[#BBF7D0] bg-[#F0FDF4] text-[#047857]'
        : result.status === 'AMBIGUOUS'
        ? 'border-[#FDE68A] bg-[#FFFBEB] text-[#A16207]'
        : result.status === 'INVALID'
        ? 'border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C]'
        : 'border-[#E4ECFC] bg-[#F8FAFE] text-[#64748B]'

    return (
        <div className={`mt-4 rounded-lg border p-3 ${tone}`}>
            <div className="flex items-start gap-2">
                {result.status === 'MATCHED'
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    : result.status === 'AMBIGUOUS'
                    ? <Users className="mt-0.5 h-4 w-4 shrink-0" />
                    : result.status === 'INVALID'
                    ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    : <Search className="mt-0.5 h-4 w-4 shrink-0" />}
                <div>
                    <div className="text-sm font-semibold">
                        {result.status === 'MATCHED' && 'Contact найден'}
                        {result.status === 'AMBIGUOUS' && 'Найдено несколько Contact'}
                        {result.status === 'INVALID' && 'Телефон заполнен неверно'}
                        {result.status === 'NOT_FOUND' && 'Contact не найден'}
                    </div>
                    <div className="mt-0.5 text-xs">
                        {result.status === 'MATCHED' && `${result.displayName} · ${result.normalizedPhone}`}
                        {result.status === 'AMBIGUOUS' && `${result.candidateCount} кандидата — автоматический выбор заблокирован`}
                        {result.status === 'INVALID' && 'Введите российский номер из 10–11 цифр'}
                        {result.status === 'NOT_FOUND' && `${result.normalizedPhone} · новый Contact не создаётся`}
                    </div>
                    {result.status === 'MATCHED' && (
                        <details className="mt-2">
                            <summary className="cursor-pointer text-xs font-medium">Технические данные</summary>
                            <div className="mt-1 font-mono text-[11px]">{result.contactId}</div>
                        </details>
                    )}
                </div>
            </div>
        </div>
    )
}
