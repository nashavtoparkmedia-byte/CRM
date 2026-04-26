'use client';

/**
 * ActivityLogView — переиспользуемое тело журнала событий.
 *
 * Используется в табе «Журнал» внутри ⚙ Глобальных настроек.
 * Авто-refresh каждые 5 сек. Можно подавить заголовок через
 * `compact` (для модалки — без заголовка, чтобы не дублировать таб).
 *
 * Вёрстка — Tailwind + shadcn (Card / Badge), без custom CSS.
 */

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from './_api-client';
import type { ActivityLogEntry } from './_types';

function fmt(ts: string): string {
  return new Date(ts).toLocaleString('ru-RU');
}

const ACTION_LABEL_RU: Record<string, string> = {
  account_acknowledged: 'Уведомление подтверждено',
  check_session_result: 'Результат проверки сессии',
  collect_responses_done: 'Сбор откликов завершён',
  collect_responses_failed: 'Ошибка сбора откликов',
  collect_responses_started: 'Начат сбор откликов',
  created: 'Аккаунт создан',
  enqueued_check_session: 'Запланирована проверка сессии',
  enqueued_open_login_window: 'Запланировано открытие входа',
  enqueued_scan_account: 'Запланировано сканирование',
  manual_collect_responses_requested: 'Ручной сбор откликов',
  manual_retry_requested: 'Ручной повтор',
  note_added: 'Заметка добавлена',
  open_login_window_ready: 'Окно входа готово',
  phone_revealed: 'Телефон раскрыт',
  phone_reveal_failed: 'Не удалось раскрыть телефон',
  reauth_completed: 'Повторный вход завершён',
  response_collected: 'Получен новый отклик',
  response_processed: 'Отклик обработан оператором',
  retry_state_updated: 'Состояние повтора обновлено',
  scan_account_done: 'Сканирование завершено',
  scan_account_failed: 'Ошибка сканирования',
  scan_account_started: 'Начато сканирование',
  snapshot_changed: 'Изменение в данных аккаунта',
  stable_id_extracted: 'Stable ID получен',
  stable_id_not_found: 'Stable ID не найден',
  updated: 'Аккаунт обновлён',
};

const ENTITY_LABEL_RU: Record<string, string> = {
  account: 'Аккаунт',
  response: 'Отклик',
  job: 'Задача',
};

const PAGE_KIND_LABEL_RU: Record<string, string> = {
  profile_ok: 'OK',
  ip_blocked: 'IP заблокирован',
  login_required: 'Нужен вход',
  unknown: 'Неизвестно',
};

const NEXT_ACTION_LABELS: Record<string, string> = {
  proceed: 'Готов',
  reauth: 'Нужно войти',
  retry_later: 'Подождать',
  inspect: 'Проверить',
};

const NEXT_ACTION_GUIDANCE: Record<string, string> = {
  proceed: 'Можно продолжать',
  reauth: 'Открой вход → войди → проверь сессию',
  retry_later: 'Подожди и повтори scan позже',
  inspect: 'Открой страницу вручную и проверь сценарий',
};

/**
 * Преобразует JSON-детали в читаемые «ключ: значение» строки.
 * Известные поля переводятся на русский; неизвестные показываются
 * как есть. Длинные значения (url) — обрезаются.
 *
 * Возвращает массив пар [label, value]. Если деталей нет → null.
 */
function renderDetails(details: unknown): Array<[string, string]> | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  const pairs: Array<[string, string]> = [];

  function take(
    key: string,
    label: string,
    transform?: (v: unknown) => string,
  ) {
    if (!(key in d) || d[key] == null) return;
    const raw = d[key];
    pairs.push([label, transform ? transform(raw) : String(raw)]);
  }

  take('accountId', 'Аккаунт ID');
  take('responseId', 'Отклик ID');
  take('externalId', 'Внешний ID');
  take('candidateName', 'Кандидат');
  take('vacancyTitle', 'Вакансия');
  take('newCount', 'Новых откликов');
  take('refreshedCount', 'В работе диалогов');
  take('unreadCount', 'Непрочитано на Avito');
  take('phoneSuccessCount', 'Телефонов раскрыто');
  take('phoneFailedCount', 'Телефонов не удалось');
  take(
    'durationMs',
    'Длительность',
    (v) => `${Math.round(Number(v) / 100) / 10} сек`,
  );
  take(
    'pageKind',
    'Состояние страницы',
    (v) => PAGE_KIND_LABEL_RU[String(v)] ?? String(v),
  );
  take(
    'nextAction',
    'Следующее действие',
    (v) => NEXT_ACTION_LABELS[String(v)] ?? String(v),
  );
  take('reason', 'Причина');
  take('note', 'Заметка');
  take('error', 'Ошибка');
  take('processedBy', 'Обработал');
  take('jobId', 'Job ID');

  if (pairs.length === 0) return null;
  return pairs;
}

function getNextActionLabel(entry: ActivityLogEntry): string | null {
  if (entry.action !== 'scan_account_done') return null;
  const details = entry.detailsJson;
  if (!details || typeof details !== 'object') return null;
  const raw = (details as Record<string, unknown>).nextAction;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return NEXT_ACTION_LABELS[trimmed] ?? trimmed;
}

function getNextActionGuidance(entry: ActivityLogEntry): string | null {
  if (entry.action !== 'scan_account_done') return null;
  const details = entry.detailsJson;
  if (!details || typeof details !== 'object') return null;
  const raw = (details as Record<string, unknown>).nextAction;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return NEXT_ACTION_GUIDANCE[trimmed] ?? null;
}

export function ActivityLogView({ compact = false }: { compact?: boolean }) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const data = await api<ActivityLogEntry[]>('/activity-log?limit=500');
      setEntries(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-3">
      {!compact && (
        <h1 className="text-2xl font-bold tracking-tight">Журнал событий</h1>
      )}

      {/* Краткая справка — свёрнута по умолчанию */}
      <details className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium text-primary">
          📖 Как использовать журнал
        </summary>
        <div className="mt-2 text-muted-foreground leading-relaxed">
          Журнал — это <strong>аудит-лог системы</strong>: что и когда
          произошло на каждом аккаунте Avito. Используется когда:
          <ul className="mt-1.5 list-disc pl-6 space-y-0.5">
            <li>что-то пошло не так и нужно понять <em>когда</em> и <em>почему</em></li>
            <li>хочется проверить — собрал ли worker отклики в нужное время</li>
            <li>нужно найти конкретное событие (кто и когда обработал лид)</li>
          </ul>
          <div className="mt-1.5">
            Список обновляется автоматически каждые 5 секунд. Показано до
            500 последних событий.
          </div>
        </div>
      </details>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Ошибка: {error}
        </div>
      )}
      {loading && entries.length === 0 && (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                  Время
                </th>
                <th className="px-3 py-2 text-left font-medium">Сущность</th>
                <th className="px-3 py-2 text-left font-medium">ID</th>
                <th className="px-3 py-2 text-left font-medium">Действие</th>
                <th className="px-3 py-2 text-left font-medium">Детали</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const nextActionLabel = getNextActionLabel(e);
                const nextActionGuidance = getNextActionGuidance(e);
                const actionRu = ACTION_LABEL_RU[e.action] ?? e.action;
                const entityRu = ENTITY_LABEL_RU[e.entityType] ?? e.entityType;
                const detailPairs = renderDetails(e.detailsJson);
                return (
                  <tr
                    key={e.id}
                    className="border-t border-border hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {fmt(e.createdAt)}
                    </td>
                    <td className="px-3 py-2">{entityRu}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {e.entityId ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{actionRu}</span>
                        {nextActionLabel !== null && (
                          <Badge variant="secondary">{nextActionLabel}</Badge>
                        )}
                      </div>
                      {nextActionGuidance !== null && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {nextActionGuidance}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-[320px]">
                      {detailPairs ? (
                        <div className="flex flex-col gap-0.5 text-xs">
                          {detailPairs.map(([k, v]) => (
                            <div
                              key={k}
                              className="truncate"
                              title={`${k}: ${v}`}
                            >
                              <span className="text-muted-foreground">
                                {k}:
                              </span>{' '}
                              <span className="font-medium text-foreground">
                                {v}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && entries.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    Пока пусто.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
