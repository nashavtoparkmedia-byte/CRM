/**
 * Avito CRM-side helpers — общая логика, которой пользуются Next.js
 * API routes под `/api/avito/*`.
 *
 * Главное здесь:
 *   - accountProfilePath() — куда worker монтирует userDataDir
 *     Chromium для конкретного аккаунта. CRM API кладёт ЭТОТ путь
 *     в `avito_accounts.profile_path` при создании; worker читает
 *     ту же строку из БД и не пересчитывает.
 *   - logActivity() — единая запись в avito_activity_log.
 *     Все ручные действия оператора (create/pause/resume/check-session/
 *     open-login-window/...) пишут сюда строку, чтобы Журнал событий
 *     был полным.
 *   - enqueueJob() — INSERT в avito_jobs, worker подхватит на
 *     следующем тике polling'а (~750ms).
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { prisma } from '@/lib/prisma'

/**
 * Корень worker'а (где живёт его storage/).
 *
 * По умолчанию — соседняя директория `avito-worker` рядом с
 * gravity-mvp (как в текущей структуре `D:\Github\CRM\`). Можно
 * переопределить через env `AVITO_WORKER_ROOT` если деплой иной.
 *
 * Worker через свой `_shared/shared/src/constants.ts` использует
 * ту же логику (PROJECT_ROOT env или fallback по __dirname); в
 * нашем случае оба пути сходятся в одну точку.
 */
const WORKER_ROOT =
  process.env.AVITO_WORKER_ROOT ??
  path.resolve(process.cwd(), '..', 'avito-worker')

/**
 * Абсолютный путь к Chromium-профилю аккаунта.
 *
 * Структура: `<WORKER_ROOT>/storage/profiles/<id>/`
 * Worker запустит Playwright с `userDataDir: <этот путь>` и в нём
 * сохранятся cookies/localStorage сессии Avito.
 */
export function accountProfilePath(accountId: number | string): string {
  return path.join(WORKER_ROOT, 'storage', 'profiles', String(accountId))
}

/**
 * Создать пустую директорию профиля. Best-effort — если mkdir
 * упадёт (нет прав, диск полон), мы всё равно вернём успех аккаунту:
 * worker создаст директорию сам при первом запуске Chromium. Лог
 * предупреждения попадает в server-stdout.
 */
export async function ensureProfileDir(profilePath: string): Promise<void> {
  try {
    await fs.mkdir(profilePath, { recursive: true })
  } catch (err) {
    console.warn(
      `[avito] failed to mkdir profile ${profilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Записать строку в avito_activity_log. Используется во всех
 * мутирующих эндпоинтах, чтобы Журнал событий показывал кто/когда
 * запросил действие — даже если worker ещё не обработал job.
 *
 * Тип сущности — обычно 'account', 'response' или 'job'. Action —
 * snake_case код (см. ACTION_LABEL_RU в _ActivityLogView.tsx, где
 * каждый код переводится на русский).
 */
export async function logActivity(
  entityType: string,
  entityId: number | string | null,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await prisma.avito_activity_log.create({
      data: {
        entity_type: entityType,
        entity_id: entityId !== null ? String(entityId) : null,
        action,
        details_json: details as any,
      },
    })
  } catch (err) {
    // Активити-лог — НЕ critical path. Если он упал, это не должно
    // ронять основной запрос. Просто залогируем в stderr.
    console.warn(
      `[avito] activity_log insert failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Поставить job в очередь worker'у. Возвращает {jobId, type, status}
 * — тот же shape что Box 1 EnqueueJobResponse, чтобы UI не пришлось
 * адаптировать.
 *
 * Worker подхватит запись на следующем JOB_POLL_INTERVAL_MS (~750ms),
 * пометит status='processing', выполнит, и проставит status='done'/
 * 'failed'. Прогресс виден в БД и в Журнале событий.
 */
export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
): Promise<{ jobId: number; type: string; status: string }> {
  const job = await prisma.avito_jobs.create({
    data: {
      type: type as any,
      payload_json: payload as any,
    },
  })
  return { jobId: job.id, type: job.type, status: job.status }
}
