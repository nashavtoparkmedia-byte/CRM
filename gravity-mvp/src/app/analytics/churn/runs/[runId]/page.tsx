import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'
import {
  getCommunicationRunReportV1,
  listCommunicationRunParticipantsV1,
  type CommunicationMetricKeyV1,
  type CommunicationRunMetricsV1,
} from '@/modules/communication-workspace/public/v1'
import { EXCLUSION_LABELS, METRIC_LABELS, OUTCOME_LABELS, STATE_LABELS } from '../../labels'
import RunControls from './RunControls'

export const dynamic = 'force-dynamic'

function metricValue(metrics: CommunicationRunMetricsV1, key: string): number {
  switch (key) {
    case 'matched': return metrics.matched
    case 'excluded': return metrics.excluded
    case 'admitted': return metrics.admitted
    case 'message_requested': return metrics.messagesRequested
    case 'message_accepted': return metrics.messagesAccepted
    case 'replied': return metrics.replied
    case 'waiting': return metrics.waiting
    case 'call_requested': return metrics.callsRequested
    case 'failed': return metrics.failed
    case 'needs_review': return metrics.needsReview
    case 'completed': return metrics.completed
    default: return 0
  }
}

const METRIC_KEY = /^(matched|excluded|admitted|message_requested|message_accepted|replied|waiting|call_requested|failed|needs_review|completed|in_progress|exclusion:[a-z_]+|outcome:[a-z_]+)$/u

export default async function RunPage({ params, searchParams }: {
  params: { runId: string } | Promise<{ runId: string }>
  searchParams?: { metric?: string } | Promise<{ metric?: string }>
}) {
  const { runId } = await Promise.resolve(params)
  const search = (await Promise.resolve(searchParams)) ?? {}
  await requireIntegrationAdminPageAccess(`/analytics/churn/runs/${runId}`)
  const report = await getCommunicationRunReportV1(runId)
  if (!report) notFound()
  const metric = (search.metric && METRIC_KEY.test(search.metric) ? search.metric : 'matched') as CommunicationMetricKeyV1
  const participants = await listCommunicationRunParticipantsV1(runId, metric)
  const m = report.metrics
  const label = METRIC_LABELS.find((item) => item.key === metric)?.label
    ?? (metric.startsWith('exclusion:') ? EXCLUSION_LABELS[metric.slice(10)] : OUTCOME_LABELS[metric.slice(8)]) ?? metric
  const waiting = participants.filter((p) => p.state === 'waiting_reply' && p.participantId).map((p) => ({ participantId: p.participantId as string, name: p.displayName ?? p.requestedContactId }))

  return (
    <PageContainer>
      <div className="mx-auto max-w-3xl space-y-4 text-[#0F172A]">
        <Link href="/analytics/churn" className="text-[14px] font-medium text-[#2AABEE]">← Отток</Link>
        <div>
          <h1 className="text-[20px] font-semibold">{report.projectTitle}</h1>
          <p className="text-[13px] text-[#64748B]">
            {report.mode === 'sandbox' ? 'Sandbox' : 'Живой'} · исполнение: {report.effectsMode === 'simulated' ? 'симуляция, провайдеры не вызываются' : 'живое'} ·
            триггер {report.triggerKey} v{report.triggerVersion} · ≥ {String(report.criteria.minInactiveDays ?? '')} дн. · запущен {new Date(report.createdAt).toLocaleString('ru-RU')}
          </p>
        </div>
        <RunControls runId={report.runId} inProgress={m.inProgress} canSimulateReply={report.mode === 'sandbox' && report.effectsMode === 'simulated'} waiting={waiting} />
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {METRIC_LABELS.map((item) => (
            <Link key={item.key} href={`?metric=${item.key}`}
              className={`rounded-xl border px-3 py-2 hover:bg-[#F1F5FD] ${metric === item.key ? 'border-[#2AABEE]' : 'border-[#E4ECFC]'}`}>
              <div className="text-[20px] font-semibold">{metricValue(m, item.key)}</div>
              <div className="text-[13px] text-[#64748B]">{item.label}</div>
            </Link>
          ))}
          <div className="rounded-xl border border-[#E4ECFC] px-3 py-2">
            <div className="text-[20px] font-semibold">{m.messagesDelivered ?? '—'} / {m.messagesRead ?? '—'}</div>
            <div className="text-[13px] text-[#64748B]">Доставлено / прочитано{m.messagesDelivered === null ? ' (нет данных провайдера)' : ''}</div>
          </div>
        </section>
        {(Object.keys(m.excludedReasons).length > 0 || Object.keys(m.outcomes).length > 0) && (
          <section className="flex flex-wrap gap-2">
            {Object.entries(m.excludedReasons).map(([reason, count]) => (
              <Link key={reason} href={`?metric=exclusion:${reason}`} className="rounded-full border border-[#E4ECFC] px-3 py-1 text-[13px] hover:bg-[#F1F5FD]">
                {EXCLUSION_LABELS[reason] ?? reason}: {count}
              </Link>
            ))}
            {Object.entries(m.outcomes).map(([outcome, count]) => (
              <Link key={outcome} href={`?metric=outcome:${outcome}`} className="rounded-full border border-[#E4ECFC] bg-[#F1F5FD] px-3 py-1 text-[13px]">
                {OUTCOME_LABELS[outcome] ?? outcome}: {count}
              </Link>
            ))}
          </section>
        )}
        <section className="rounded-xl border border-[#E4ECFC]">
          <h2 className="px-4 pt-3 text-[17px] font-semibold">{label}: {participants.length}</h2>
          {participants.length === 0 ? (
            <p className="px-4 py-3 text-[14px] text-[#64748B]">Никого.</p>
          ) : (
            <ul className="divide-y divide-[#E4ECFC]">
              {participants.map((p) => (
                <li key={p.audienceMemberId}>
                  <Link href={`/analytics/churn/runs/${report.runId}/members/${p.audienceMemberId}`} className="flex min-h-[56px] items-center justify-between gap-3 px-4 py-2 hover:bg-[#F1F5FD]">
                    <div>
                      <div className="text-[15px] font-medium">{p.displayName ?? p.requestedContactId}</div>
                      <div className="text-[12px] text-[#64748B]">{p.reason}</div>
                    </div>
                    <div className="text-right text-[12px] text-[#64748B]">
                      {p.admission === 'excluded'
                        ? EXCLUSION_LABELS[p.exclusionReason ?? ''] ?? p.exclusionReason
                        : `${STATE_LABELS[p.state ?? ''] ?? p.state}${p.outcome ? ` · ${OUTCOME_LABELS[p.outcome] ?? p.outcome}` : ''}`}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  )
}
