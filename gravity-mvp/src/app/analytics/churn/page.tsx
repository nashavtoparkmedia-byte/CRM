import Link from 'next/link'
import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'
import { CHURN_RETURN_PROJECT_V1, communicationEffectsModeForDisplayV1, listCommunicationRunsV1 } from '@/modules/communication-workspace/public/v1'
import { evaluateChurnTriggerAction } from './actions'
import ChurnHostClient from './ChurnHostClient'

export const dynamic = 'force-dynamic'

/** «Отток»: the first host of Communication Workspace. */
export default async function ChurnPage() {
  await requireIntegrationAdminPageAccess('/analytics/churn')
  const [evaluation, runs, effectsMode] = await Promise.all([
    evaluateChurnTriggerAction(5),
    listCommunicationRunsV1(20),
    communicationEffectsModeForDisplayV1(),
  ])
  const flow = CHURN_RETURN_PROJECT_V1.flow
  return (
    <PageContainer>
      <div className="mx-auto max-w-3xl space-y-4 text-[#0F172A]">
        <div>
          <h1 className="text-[20px] font-semibold">Отток</h1>
          <p className="text-[13px] text-[#64748B]">Триггер Оттока выбирает водителей, Communication Workspace ведёт сценарий, отчёт строится по фактам исполнения.</p>
        </div>
        {effectsMode === 'simulated' ? (
          <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] px-4 py-3 text-[14px]">
            Режим исполнения: <b>симуляция</b>. Ни одно сообщение и ни один звонок не уходят провайдерам — результаты детерминированные.
          </div>
        ) : (
          <div className="rounded-xl border border-[#DC2626] px-4 py-3 text-[14px] text-[#DC2626]">
            Режим исполнения: <b>живой</b>. Реальные эффекты разрешены только тестовым контактам Sandbox.
          </div>
        )}
        <section className="rounded-xl border border-[#E4ECFC] p-4">
          <h2 className="text-[17px] font-semibold">Сценарий «{CHURN_RETURN_PROJECT_V1.title}»</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[15px]">
            <li>Проверить триггер: не выполнял заказы ≥ N дней.</li>
            <li>Снимок аудитории; «не беспокоить», политика проекта, пауза между сценариями.</li>
            <li>Сообщение через SendToContact: «{flow.message.text}»</li>
            <li>Ждать ответа {Math.round(flow.waitReplySeconds / 3600)} ч (в Sandbox — секунды).</li>
            <li>Ответил — остановиться. Не ответил — AI-звонок.</li>
            <li>Исход, журнал решений и отчёт.</li>
          </ol>
        </section>
        <ChurnHostClient initial={evaluation} />
        <section className="rounded-xl border border-[#E4ECFC]">
          <h2 className="px-4 pt-3 text-[17px] font-semibold">Запуски</h2>
          {runs.length === 0 ? (
            <p className="px-4 py-3 text-[14px] text-[#64748B]">Запусков пока нет.</p>
          ) : (
            <ul className="divide-y divide-[#E4ECFC]">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link href={`/analytics/churn/runs/${run.id}`} className="flex min-h-[56px] items-center justify-between px-4 hover:bg-[#F1F5FD]">
                    <span className="text-[15px] font-medium">{run.projectTitle} · {run.mode === 'sandbox' ? 'Sandbox' : 'Живой'}</span>
                    <span className="text-[12px] text-[#64748B]">{new Date(run.createdAt).toLocaleString('ru-RU')}</span>
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
