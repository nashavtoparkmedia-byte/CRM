// Russian labels for the Отток → Communication Workspace screens.

export const EXCLUSION_LABELS: Record<string, string> = {
  duplicate_in_snapshot: 'Повтор в выборке',
  duplicate_canonical_contact: 'Тот же человек дважды',
  contact_unknown: 'Контакт не найден',
  contact_archived: 'Контакт в архиве',
  contact_restricted: '«Не беспокоить» в Контактах',
  permission_unavailable: 'Разрешение не проверено',
  project_policy: 'Запрещено политикой проекта',
  sandbox_not_allowlisted: 'Не тестовый контакт (Sandbox)',
  suppressed_active_elsewhere: 'Уже в другом сценарии',
  cooldown: 'Пауза после прошлого сценария',
}

export const STATE_LABELS: Record<string, string> = {
  admitted: 'Принят, ждёт отправки',
  waiting_reply: 'Ждём ответа',
  calling: 'Звоним',
  completed: 'Завершён',
  blocked: 'Остановлен',
  needs_review: 'Нужна проверка',
  failed: 'Ошибка',
}

export const OUTCOME_LABELS: Record<string, string> = {
  replied: 'Ответил',
  no_reply: 'Не ответил',
  call_answered: 'Звонок: ответил',
  call_no_answer: 'Звонок: не ответил',
  call_failed: 'Звонок: ошибка',
  call_unavailable: 'Звонок недоступен',
  call_not_allowed: 'Звонок запрещён политикой',
  message_refused: 'Сообщение отклонено',
  message_unavailable: 'Сообщение не отправить',
  permission_denied: 'Связь запрещена',
  sandbox_blocked: 'Заблокировано Sandbox',
  outcome_unknown: 'Исход неизвестен — без повтора',
}

export const EVENT_LABELS: Record<string, string> = {
  trigger_evaluated: 'Триггер проверен',
  contact_admitted: 'Контакт принят в сценарий',
  contact_excluded: 'Контакт исключён',
  permission_rechecked: 'Разрешение проверено перед действием',
  message_requested: 'Запрошена отправка (SendToContact)',
  simulated_provider_effect: 'Симуляция провайдера (ничего не отправлено)',
  message_accepted: 'Сообщение принято',
  message_refused: 'Сообщение отклонено',
  message_indeterminate: 'Исход отправки неизвестен — не повторяем',
  message_sandbox_blocked: 'Отправка заблокирована Sandbox',
  sandbox_blocked: 'Заблокировано Sandbox',
  wait_started: 'Начато ожидание ответа',
  sandbox_reply_simulated: 'Ответ (симуляция Sandbox)',
  reply_detected: 'Ответ получен — дальше не воздействуем',
  wait_elapsed: 'Ожидание истекло',
  reply_evidence_unavailable: 'Нет данных об ответе — не звоним',
  call_requested: 'Запрошен звонок',
  call_answered: 'Звонок: ответил',
  call_no_answer: 'Звонок: не ответил',
  call_failed: 'Звонок: ошибка',
  call_unavailable: 'Звонок недоступен',
  call_indeterminate: 'Исход звонка неизвестен — не перезваниваем',
  call_sandbox_blocked: 'Звонок заблокирован Sandbox',
}

export const METRIC_LABELS: Array<{ key: string; label: string }> = [
  { key: 'matched', label: 'Подошли под триггер' },
  { key: 'excluded', label: 'Исключены политикой' },
  { key: 'admitted', label: 'Приняты в Run' },
  { key: 'message_requested', label: 'Сообщений запрошено' },
  { key: 'message_accepted', label: 'Сообщений принято' },
  { key: 'replied', label: 'Ответили' },
  { key: 'waiting', label: 'В ожидании' },
  { key: 'call_requested', label: 'Перешли к звонку' },
  { key: 'failed', label: 'Ошибка' },
  { key: 'needs_review', label: 'Нужна проверка' },
  { key: 'completed', label: 'Завершены' },
]
