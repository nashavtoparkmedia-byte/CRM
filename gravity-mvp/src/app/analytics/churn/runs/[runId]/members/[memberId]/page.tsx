import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'
import { getCommunicationParticipantTimelineV1 } from '@/modules/communication-workspace/public/v1'
import { EVENT_LABELS, EXCLUSION_LABELS, OUTCOME_LABELS, STATE_LABELS } from '../../../../labels'

export const dynamic = 'force-dynamic'

/** Metric → Contacts → this Contact → its full execution timeline, from the audit trail. */
export default async function MemberTimelinePage({ params }: { params: { runId: string; memberId: string } | Promise<{ runId: string; memberId: string }> }) {
  const { runId, memberId } = await Promise.resolve(params)
  await requireIntegrationAdminPageAccess(`/analytics/churn/runs/${runId}/members/${memberId}`)
  const timeline = await getCommunicationParticipantTimelineV1(runId, memberId)
  if (!timeline) notFound()
  const p = timeline.participant
  return (
    <PageContainer>
      <div className="mx-auto max-w-3xl space-y-4 text-[#0F172A]">
        <Link href={`/analytics/churn/runs/${runId}`} className="text-[14px] font-medium text-[#2AABEE]">← Отчёт запуска</Link>
        <div>
          <h1 className="text-[20px] font-semibold">{p.displayName ?? p.requestedContactId}</h1>
          <p className="text-[13px] text-[#64748B]">{p.reason}</p>
          <p className="mt-1 text-[15px]">
            {p.admission === 'excluded'
              ? `Исключён: ${EXCLUSION_LABELS[p.exclusionReason ?? ''] ?? p.exclusionReason}`
              : `${STATE_LABELS[p.state ?? ''] ?? p.state}${p.outcome ? ` · ${OUTCOME_LABELS[p.outcome] ?? p.outcome}` : ''}`}
          </p>
          {p.canonicalContactId && (
            <Link href={`/contacts/${encodeURIComponent(p.canonicalContactId)}`} className="text-[14px] font-medium text-[#2AABEE]">Карточка человека</Link>
          )}
        </div>
        <section className="rounded-xl border border-[#E4ECFC] p-4">
          <h2 className="text-[17px] font-semibold">Почему он здесь</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[14px]">
            {Object.entries(timeline.businessContext).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-[#64748B]">{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="rounded-xl border border-[#E4ECFC]">
          <h2 className="px-4 pt-3 text-[17px] font-semibold">Журнал исполнения</h2>
          <ol className="divide-y divide-[#E4ECFC]">
            {timeline.events.map((item, index) => (
              <li key={`${item.kind}-${index}`} className="px-4 py-2">
                <div className="flex justify-between gap-3">
                  <span className="text-[15px] font-medium">{EVENT_LABELS[item.kind] ?? item.kind}</span>
                  <span className="text-[12px] text-[#64748B]">{new Date(item.occurredAt).toLocaleTimeString('ru-RU')}</span>
                </div>
                <div className="text-[12px] text-[#64748B]">
                  {Object.entries(item.detail)
                    .filter(([key]) => !['audienceMemberId', 'requestedContactId'].includes(key))
                    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </PageContainer>
  )
}
