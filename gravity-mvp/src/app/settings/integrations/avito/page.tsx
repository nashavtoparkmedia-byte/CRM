'use client';

// Avito → Settings → Integrations → Avito.
// Управление Chromium-профилями скрапера: добавление аккаунтов,
// глобальные настройки сбора, авто-ответ, журнал событий.
//
// Сами лиды (отклики кандидатов) живут в унифицированном /leads/new —
// см. LeadIntake-сервис, который автоматически создаёт Chat + Contact
// на каждый новый отклик через webhook от avito-worker'а.
//
// Вся вёрстка — shadcn/ui + Tailwind utility-классы (без custom CSS).
// Единый стиль с другими интеграциями (Telegram / WhatsApp / MAX / Bot).

import { useEffect, useMemo, useState } from 'react';
import {
  Megaphone,
  Pencil,
  Check,
  X,
  Settings as SettingsIcon,
  Plus,
  Play,
  Pause,
  Trash2,
  RotateCcw,
  Timer,
  Mail,
  ExternalLink,
  Sparkles,
  Eye,
  EyeOff,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from './_api-client';
import {
  accountAction,
  accountReason,
  computeAccountHealth,
  computeAttention,
  type Account,
  type AccountHealth,
  type AttentionLevel,
  type GlobalSettings,
} from './_types';
import { ActivityLogView } from './_ActivityLogView';

// ───────────────────────────────────────────────────────────────────────
// Helpers / constants
// ───────────────────────────────────────────────────────────────────────

function fmt(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU');
}

const ATTENTION_LABEL: Record<AttentionLevel, string> = {
  ok: 'ок',
  'needs-attention': 'внимание',
  critical: 'критично',
};

const HEALTH_LABEL: Record<AccountHealth, string> = {
  healthy: 'норма',
  degraded: 'сбои',
  'auto-paused': 'авто-пауза',
};

const STATUS_LABEL: Record<string, string> = {
  new: 'новый',
  auth_pending: 'ожидает входа',
  active: 'активен',
  reauth_required: 'нужен повторный вход',
  paused: 'на паузе',
  error: 'ошибка',
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

// Tailwind classes для бейджей по статусу/здоровью/вниманию.
// Держим в одном месте — единый источник правды для цветов.
const STATUS_BADGE_CLASS: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800 border-blue-200',
  auth_pending: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  active: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  reauth_required: 'bg-red-100 text-red-800 border-red-200',
  paused: 'bg-slate-100 text-slate-700 border-slate-200',
  error: 'bg-red-100 text-red-800 border-red-200',
};

const HEALTH_BADGE_CLASS: Record<AccountHealth, string> = {
  healthy: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  degraded: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  'auto-paused': 'bg-red-100 text-red-800 border-red-200',
};

const ATTENTION_PILL_CLASS: Record<AttentionLevel, string> = {
  ok: 'bg-slate-100 text-slate-600 border-slate-200',
  'needs-attention': 'bg-yellow-100 text-yellow-800 border-yellow-200',
  critical: 'bg-red-100 text-red-800 border-red-200',
};

const ATTENTION_ROW_TINT: Record<AttentionLevel, string> = {
  ok: '',
  'needs-attention': 'bg-yellow-50/40',
  critical: 'bg-red-50/40',
};

type HealthFilter = 'all' | AccountHealth | 'problem';
const FILTER_TABS: { key: HealthFilter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'problem', label: 'Проблемные' },
  { key: 'healthy', label: 'Норма' },
  { key: 'degraded', label: 'Сбои' },
  { key: 'auto-paused', label: 'Авто-пауза' },
];

// ───────────────────────────────────────────────────────────────────────
// AccountFieldEditor — inline edit для name / loginPhone в строке таблицы
// ───────────────────────────────────────────────────────────────────────

function AccountFieldEditor({
  account,
  field,
  label,
  placeholder,
  bold,
  maxLength,
  onSaved,
}: {
  account: Account;
  field: 'name' | 'loginPhone';
  label: string;
  placeholder?: string;
  bold?: boolean;
  maxLength: number;
  onSaved: () => void;
}) {
  const current = (account[field] ?? '') as string;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(current), [current]);

  async function save() {
    const trimmed = value.trim();
    if (field === 'name' && !trimmed) {
      setValue(current);
      setEditing(false);
      return;
    }
    if (trimmed === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const payload =
        field === 'loginPhone'
          ? { loginPhone: trimmed.length > 0 ? trimmed : null }
          : { name: trimmed };
      await api(`/accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      setValue(current);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setValue(current);
    setEditing(false);
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {current.length > 0 ? (
          <span className={bold ? 'font-medium' : ''}>{current}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={`Изменить ${label.toLowerCase()}`}
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        autoFocus
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') cancel();
        }}
        disabled={saving}
        className="h-7 w-44 text-sm"
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => void save()}
        disabled={saving}
      >
        {saving ? '…' : <Check className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={cancel}
        disabled={saving}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────
// GlobalSettingsModal — большая модалка с табами Общие / Telegram / Журнал
// ───────────────────────────────────────────────────────────────────────

function GlobalSettingsModal({
  settings,
  accountCount,
  open,
  onClose,
  onSaved,
}: {
  settings: GlobalSettings;
  accountCount: number;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialMinutes =
    settings.responsesPollDefaultSec !== null
      ? Math.round(settings.responsesPollDefaultSec / 60).toString()
      : '';
  const initialReply = settings.autoReplyText ?? '';
  const initialChatId = settings.telegramChatId ?? '';
  const [minutes, setMinutes] = useState(initialMinutes);
  const [reply, setReply] = useState(initialReply);
  const [savingInterval, setSavingInterval] = useState(false);
  const [savingReply, setSavingReply] = useState(false);
  const [tgTokenInput, setTgTokenInput] = useState('');
  const [tgChatIdInput, setTgChatIdInput] = useState(initialChatId);
  const [tgNotifyNew, setTgNotifyNew] = useState(settings.notifyNewResponse);
  const [tgNotifyPause, setTgNotifyPause] = useState(settings.notifyAutoPause);
  const [tgNotifyDegraded, setTgNotifyDegraded] = useState(
    settings.notifyAccountDegraded,
  );
  const [savingTg, setSavingTg] = useState(false);
  const [testingTg, setTestingTg] = useState(false);
  const [tgTestResult, setTgTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  useEffect(() => setMinutes(initialMinutes), [initialMinutes]);
  useEffect(() => setReply(initialReply), [initialReply]);
  useEffect(() => setTgChatIdInput(initialChatId), [initialChatId]);
  useEffect(
    () => setTgNotifyNew(settings.notifyNewResponse),
    [settings.notifyNewResponse],
  );
  useEffect(
    () => setTgNotifyPause(settings.notifyAutoPause),
    [settings.notifyAutoPause],
  );
  useEffect(
    () => setTgNotifyDegraded(settings.notifyAccountDegraded),
    [settings.notifyAccountDegraded],
  );

  async function saveInterval() {
    setSavingInterval(true);
    try {
      const trimmed = minutes.trim();
      await api('/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          responsesPollDefaultSec:
            trimmed === '' ? null : Math.max(1, Number(trimmed)) * 60,
        }),
      });
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingInterval(false);
    }
  }

  async function saveReply() {
    setSavingReply(true);
    try {
      const trimmed = reply.trim();
      await api('/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          autoReplyText: trimmed.length > 0 ? trimmed : null,
        }),
      });
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingReply(false);
    }
  }

  async function saveTg() {
    setSavingTg(true);
    setTgTestResult(null);
    try {
      const body: Record<string, unknown> = {
        telegramChatId: tgChatIdInput.trim() || null,
        notifyNewResponse: tgNotifyNew,
        notifyAutoPause: tgNotifyPause,
        notifyAccountDegraded: tgNotifyDegraded,
      };
      const typedToken = tgTokenInput.trim();
      if (typedToken.length > 0) {
        body.telegramBotToken = typedToken;
      }
      await api('/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setTgTokenInput('');
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTg(false);
    }
  }

  async function clearTgToken() {
    if (!confirm('Очистить bot_token? Уведомления отключатся.')) return;
    setSavingTg(true);
    setTgTestResult(null);
    try {
      await api('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ telegramBotToken: null }),
      });
      setTgTokenInput('');
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTg(false);
    }
  }

  async function testTg() {
    setTestingTg(true);
    setTgTestResult(null);
    try {
      const res = await api<{ ok: boolean; error?: string }>(
        '/settings/telegram/test',
        { method: 'POST' },
      );
      if (res.ok) {
        setTgTestResult({ ok: true, message: '✓ Сообщение отправлено' });
      } else {
        setTgTestResult({
          ok: false,
          message: res.error ?? 'Telegram отклонил сообщение',
        });
      }
    } catch (e) {
      setTgTestResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTestingTg(false);
    }
  }

  const intervalDirty = minutes !== initialMinutes;
  const replyDirty = reply !== initialReply;

  // ── Калькулятор загрузки worker'а ─────────────────────────────────
  const typedMin = Number(minutes.trim());
  const previewMin =
    minutes.trim() !== '' && Number.isFinite(typedMin) && typedMin > 0
      ? typedMin
      : settings.responsesPollDefaultSec !== null
        ? Math.round(settings.responsesPollDefaultSec / 60)
        : 10;
  const accountsN = Math.max(1, accountCount);
  const avgJobSec = 60;
  const cycleMin = (accountsN * avgJobSec) / 60;
  const utilization = cycleMin / previewMin;
  type Level = 'ok' | 'tight' | 'bad';
  const level: Level =
    utilization > 1 ? 'bad' : utilization > 0.67 ? 'tight' : 'ok';
  const levelClass: Record<Level, string> = {
    ok: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    tight: 'bg-yellow-50 text-yellow-900 border-yellow-200',
    bad: 'bg-red-50 text-red-900 border-red-200',
  };
  const levelTitle: Record<Level, string> = {
    ok: '✅ Комфортно — большой запас',
    tight: '⚠️ Впритык — запас маленький',
    bad: '❌ Не успеваем — интервал слишком короткий',
  };
  const systemEveryMin = Math.round((previewMin / accountsN) * 10) / 10;
  const actualPerAccountMin = Math.round(cycleMin * 10) / 10;
  const suggestedMin = Math.ceil(cycleMin * 1.5);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" /> Глобальные настройки
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex flex-col flex-1 min-h-0">
          <TabsList className="mx-6 mb-2 grid w-auto grid-cols-3">
            <TabsTrigger value="general">Общие</TabsTrigger>
            <TabsTrigger value="telegram">Telegram</TabsTrigger>
            <TabsTrigger value="activity">Журнал</TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
            {/* ── Общие ──────────────────────────────────────────── */}
            <TabsContent value="general" className="space-y-6 mt-2">
              <div>
                <Label className="mb-1.5 block">
                  Глобальный интервал сбора откликов
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    className="w-24"
                    value={minutes}
                    placeholder="10"
                    onChange={(e) => setMinutes(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveInterval();
                    }}
                    disabled={savingInterval}
                  />
                  <span className="text-sm text-muted-foreground">мин</span>
                  {intervalDirty && (
                    <Button
                      size="sm"
                      onClick={() => void saveInterval()}
                      disabled={savingInterval}
                    >
                      {savingInterval ? '…' : 'Сохранить'}
                    </Button>
                  )}
                </div>

                <div
                  className={cn(
                    'mt-3 rounded-md border p-3 text-sm leading-relaxed',
                    levelClass[level],
                  )}
                >
                  <div className="font-semibold mb-1.5">{levelTitle[level]}</div>
                  <div>
                    Активных аккаунтов: <strong>{accountsN}</strong>. Среднее
                    время одного полного сбора с одного аккаунта —{' '}
                    <strong>~{avgJobSec}с</strong>. Полный цикл по всем ≈{' '}
                    <strong>{actualPerAccountMin} мин</strong>.
                  </div>
                  <div className="mt-2 rounded bg-white/60 p-2 text-xs space-y-1">
                    {level !== 'bad' ? (
                      <>
                        <div>
                          ⏱ Проверка каждого профиля —{' '}
                          <strong>раз в {previewMin} мин</strong>
                        </div>
                        <div>
                          ⏱ Средний темп системы —{' '}
                          <strong>новый скан каждые {systemEveryMin} мин</strong>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          ⏱ Проверка каждого профиля фактически —{' '}
                          <strong>раз в ~{actualPerAccountMin} мин</strong>{' '}
                          <span className="opacity-70">
                            (хотели раз в {previewMin}, но не успеваем)
                          </span>
                        </div>
                        <div>
                          ⏱ Средний темп системы —{' '}
                          <strong>новый скан каждые ~{avgJobSec}с</strong>{' '}
                          <span className="opacity-70">
                            (worker работает непрерывно)
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  {level !== 'ok' && (
                    <div className="mt-2">
                      {level === 'tight' && (
                        <>
                          Запас небольшой: цикл (
                          <strong>{actualPerAccountMin} мин</strong>) почти
                          занимает весь интервал ({previewMin} мин). Для
                          надёжности рекомендую интервал ≥{' '}
                          <strong>{suggestedMin} мин</strong>.
                        </>
                      )}
                      {level === 'bad' && (
                        <>
                          Полный цикл всех аккаунтов занимает{' '}
                          <strong>{actualPerAccountMin} мин</strong>, а
                          интервал задан в {previewMin} мин. Увеличь интервал
                          минимум до <strong>{suggestedMin} мин</strong> или
                          удали часть аккаунтов.
                        </>
                      )}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] opacity-75">
                    Расчёт игнорирует per-account override'ы. Среднее время
                    скана — оценка; реально 20–120с в зависимости от
                    количества новых диалогов.
                  </div>
                </div>
              </div>

              <hr className="border-border" />

              <div>
                <Label className="mb-1.5 block">Глобальный авто-ответ</Label>
                <textarea
                  value={reply}
                  maxLength={4000}
                  rows={4}
                  placeholder="Пусто — нет глобального авто-ответа. Только те аккаунты, где задан свой текст в кнопке «Авто-ответ», будут отвечать."
                  onChange={(e) => setReply(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {replyDirty && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      onClick={() => void saveReply()}
                      disabled={savingReply}
                    >
                      {savingReply ? '…' : 'Сохранить'}
                    </Button>
                  </div>
                )}
                <div className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  <div className="font-semibold text-foreground">Как работает:</div>
                  <ol className="list-decimal pl-5 space-y-0.5">
                    <li>Система находит новый непрочитанный отклик в мессенджере одного из аккаунтов.</li>
                    <li>Заходит в диалог, нажимает «Показать телефон», сохраняет номер.</li>
                    <li>Печатает этот текст в поле сообщения и отправляет.</li>
                    <li>Отправляется <strong>ровно один раз</strong> на диалог — повторно никогда.</li>
                  </ol>
                  <div className="font-semibold text-foreground mt-2">
                    Приоритет источника текста:
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5">
                    <li>Если в аккаунте задан собственный текст («Авто-ответ ✓») — используется он.</li>
                    <li>Иначе — вот этот глобальный.</li>
                    <li>Иначе — не отправляется.</li>
                  </ul>
                </div>
              </div>
            </TabsContent>

            {/* ── Telegram ───────────────────────────────────────── */}
            <TabsContent value="telegram" className="mt-2">
              <Label className="mb-1.5 block">📢 Telegram уведомления</Label>
              <div className="flex flex-col gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      placeholder={
                        settings.telegramBotTokenSet
                          ? 'оставьте пустым — не менять'
                          : 'bot_token от @BotFather'
                      }
                      value={tgTokenInput}
                      onChange={(e) => setTgTokenInput(e.target.value)}
                      disabled={savingTg}
                      className="flex-1"
                    />
                    {settings.telegramBotTokenSet && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void clearTgToken()}
                        disabled={savingTg}
                      >
                        Очистить
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {settings.telegramBotTokenSet
                      ? `Текущий: ${settings.telegramBotTokenMasked}`
                      : 'Не настроен'}
                  </div>
                </div>
                <Input
                  type="text"
                  placeholder="chat_id (напр. 123456789 или -100xxxxxxxxxx для группы)"
                  value={tgChatIdInput}
                  onChange={(e) => setTgChatIdInput(e.target.value)}
                  disabled={savingTg}
                />
                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={tgNotifyNew}
                      onCheckedChange={(c) => setTgNotifyNew(!!c)}
                    />
                    <span>🆕 Новый отклик (лид)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={tgNotifyPause}
                      onCheckedChange={(c) => setTgNotifyPause(!!c)}
                    />
                    <span>⏸ Аккаунт авто-приостановлен</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={tgNotifyDegraded}
                      onCheckedChange={(c) => setTgNotifyDegraded(!!c)}
                    />
                    <span>⚠️ Аккаунт не работает (login/ip)</span>
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => void saveTg()}
                    disabled={savingTg}
                  >
                    {savingTg ? '…' : 'Сохранить'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void testTg()}
                    disabled={testingTg || !settings.telegramBotTokenSet}
                    title={
                      settings.telegramBotTokenSet
                        ? 'Отправить тестовое сообщение'
                        : 'Сначала сохраните bot_token'
                    }
                  >
                    {testingTg ? '…' : 'Тест'}
                  </Button>
                </div>
                {tgTestResult && (
                  <div
                    className={cn(
                      'rounded-md border px-3 py-2 text-sm',
                      tgTestResult.ok
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : 'bg-red-50 text-red-800 border-red-200',
                    )}
                  >
                    {tgTestResult.message}
                  </div>
                )}
                <div className="text-xs text-muted-foreground leading-relaxed">
                  <div className="font-semibold text-foreground">Как настроить:</div>
                  <ol className="list-decimal pl-5 space-y-0.5">
                    <li>
                      Напиши <code className="rounded bg-muted px-1">@BotFather</code>{' '}
                      в Telegram → <code className="rounded bg-muted px-1">/newbot</code>{' '}
                      → получи <code className="rounded bg-muted px-1">bot_token</code>.
                    </li>
                    <li>Найди своего бота в TG, отправь ему любое сообщение.</li>
                    <li>
                      Узнай свой <code className="rounded bg-muted px-1">chat_id</code>:
                      напиши <code className="rounded bg-muted px-1">@userinfobot</code>.
                    </li>
                    <li>Вставь оба значения сюда, жми «Сохранить», потом «Тест».</li>
                  </ol>
                </div>
              </div>
            </TabsContent>

            {/* ── Журнал ─────────────────────────────────────────── */}
            <TabsContent value="activity" className="mt-2">
              <ActivityLogView compact />
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="px-6 py-4 border-t">
          <Button onClick={onClose}>Закрыть</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────
// AccountHealthPopover — read-only popover полного health-набора
// ───────────────────────────────────────────────────────────────────────

function AccountHealthPopover({
  account,
  open,
  onClose,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
}) {
  const reason = accountReason(account);
  const action = accountAction(account);
  const health = computeAccountHealth(account);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Состояние аккаунта</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Badge
            variant="outline"
            className={cn('border', HEALTH_BADGE_CLASS[health])}
          >
            {HEALTH_LABEL[health]}
          </Badge>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Причина
            </div>
            <div className="mt-0.5 text-base font-medium">{reason}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Что делать
            </div>
            <div className="mt-0.5 text-base font-medium">{action}</div>
          </div>
          <hr className="border-border" />
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground w-1/2">
                  Account ID
                </th>
                <td className="py-1.5">{account.id}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Название
                </th>
                <td className="py-1.5">{account.name}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Последний сбор откликов
                </th>
                <td className="py-1.5">{fmt(account.lastCollectResponsesAt)}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Последний результат
                </th>
                <td className="py-1.5">{account.lastCollectPageKind ?? '—'}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Требует повтора
                </th>
                <td className="py-1.5">{account.retryRequired ? 'да' : 'нет'}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Ошибок за 24 часа
                </th>
                <td className="py-1.5">{account.collectFailCount24h ?? 0}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  IP-блоков за 24 часа
                </th>
                <td className="py-1.5">{account.ipBlockedCount24h ?? 0}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Нужен вход за 24 часа
                </th>
                <td className="py-1.5">{account.loginRequiredCount24h ?? 0}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Последний сбор занял
                </th>
                <td className="py-1.5">
                  {account.lastCollectDurationMs != null
                    ? `${account.lastCollectDurationMs} мс`
                    : '—'}
                </td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Телефонов получено
                </th>
                <td className="py-1.5">{account.lastCollectPhoneSuccessCount ?? 0}</td>
              </tr>
              <tr>
                <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  Телефонов не удалось
                </th>
                <td className="py-1.5">{account.lastCollectPhoneFailedCount ?? 0}</td>
              </tr>
              {account.autoPausedAt && (
                <>
                  <tr>
                    <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                      Авто-пауза с
                    </th>
                    <td className="py-1.5">{fmt(account.autoPausedAt)}</td>
                  </tr>
                  <tr>
                    <th className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                      Причина авто-паузы
                    </th>
                    <td className="py-1.5">{account.autoPauseReason ?? '—'}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Закрыть</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────
// EditIntervalModal
// ───────────────────────────────────────────────────────────────────────

function EditIntervalModal({
  account,
  settings,
  open,
  onClose,
  onSaved,
}: {
  account: Account;
  settings: GlobalSettings;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial =
    account.responsesPollIntervalSec !== null
      ? Math.round(account.responsesPollIntervalSec / 60).toString()
      : '';
  const globalMin =
    settings.responsesPollDefaultSec !== null
      ? Math.round(settings.responsesPollDefaultSec / 60)
      : 10;
  const [minutes, setMinutes] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const trimmed = minutes.trim();
      await api(`/accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          responsesPollIntervalSec:
            trimmed === '' ? null : Math.max(1, Number(trimmed)) * 60,
        }),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Интервал сбора: {account.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label className="mb-1.5 block">Интервал проверки мессенджера</Label>
            <div className="flex items-center gap-2">
              <Input
                value={minutes}
                placeholder={`${globalMin} (глобальный)`}
                onChange={(e) => setMinutes(e.target.value)}
                disabled={saving}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">мин</span>
            </div>
          </div>
          {err && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {err}
            </div>
          )}
          <div className="text-xs text-muted-foreground leading-relaxed space-y-2">
            <div>
              <strong className="text-foreground">Как это работает.</strong> Раз в
              указанное число минут система заходит в мессенджер этого аккаунта
              и проверяет новые непрочитанные отклики. Если есть — заходит в
              диалог, раскрывает телефон и отправляет авто-ответ (если задан).
            </div>
            <div>
              <strong className="text-foreground">Приоритет:</strong> если
              указано значение — используется оно (per-account override). Если
              поле пустое — применяется глобальный интервал (
              <strong>{globalMin} мин</strong>) из «⚙ Глобальные настройки».
            </div>
            <div>
              <strong className="text-foreground">Важно:</strong> чаще 1 раза в
              3-5 мин не рекомендуется — Avito может принять это за подозри-
              тельную активность и начать возвращать IP-block.
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────
// AddAccountModal
// ───────────────────────────────────────────────────────────────────────

function AddAccountModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [loginPhone, setLoginPhone] = useState('');
  const [autoReplyText, setAutoReplyText] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          loginPhone: loginPhone.trim() || undefined,
          autoReplyText: autoReplyText.trim() || undefined,
        }),
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый аккаунт</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label className="mb-1.5 block">Название</Label>
            <Input
              value={name}
              required
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1.5 block">Телефон (логин)</Label>
            <Input
              value={loginPhone}
              maxLength={50}
              onChange={(e) => setLoginPhone(e.target.value)}
              placeholder="+7..."
            />
          </div>
          <div>
            <Label className="mb-1.5 block">
              Авто-ответ{' '}
              <span className="text-xs text-muted-foreground font-normal">
                (отправляется 1 раз после получения номера; пусто — не
                отправляется)
              </span>
            </Label>
            <textarea
              value={autoReplyText}
              maxLength={4000}
              rows={4}
              placeholder="Пример: Здравствуйте! Получили ваш отклик, перезвоним в ближайшее время."
              onChange={(e) => setAutoReplyText(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {err && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {err}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Сохранение…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────
// EditAutoReplyModal
// ───────────────────────────────────────────────────────────────────────

function EditAutoReplyModal({
  account,
  open,
  onClose,
  onSaved,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(account.autoReplyText ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const trimmed = text.trim();
      await api(`/accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          autoReplyText: trimmed.length > 0 ? trimmed : null,
        }),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Авто-ответ: {account.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label className="mb-1.5 block">
              Текст авто-ответа{' '}
              <span className="text-xs text-muted-foreground font-normal">
                (пусто = не отправлять; 1 раз на диалог после номера)
              </span>
            </Label>
            <textarea
              value={text}
              maxLength={4000}
              rows={6}
              placeholder="Пример: Здравствуйте! Получили ваш отклик, перезвоним в ближайшее время."
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {err && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {err}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────
// ContextExportModal — два промта (Claude / GPT) для нового AI-чата
// ───────────────────────────────────────────────────────────────────────

function ContextExportModal({
  account,
  open,
  onClose,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    claudePrompt: string;
    gptPrompt: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'claude' | 'gpt'>('claude');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ claudePrompt: string; gptPrompt: string }>(
      `/accounts/${account.id}/context-export`,
    )
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  async function copy(text: string, id: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  const active = data
    ? tab === 'claude'
      ? data.claudePrompt
      : data.gptPrompt
    : '';
  const combined = data
    ? `${data.claudePrompt}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${data.gptPrompt}`
    : '';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Контекст для нового чата: {account.name}</DialogTitle>
          <DialogDescription>
            Два готовых промта для передачи в новый чат. Телефоны маскированы,
            cookies / session-токены не включены.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="text-sm text-muted-foreground">Собираем контекст…</div>
        )}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Не удалось собрать контекст: {error}
          </div>
        )}

        {!loading && !error && data && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'claude' | 'gpt')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="claude">
                Промт для Клода{' '}
                <span className="ml-1.5 text-xs opacity-70">
                  {data.claudePrompt.length.toLocaleString('ru-RU')}
                </span>
              </TabsTrigger>
              <TabsTrigger value="gpt">
                Промт для GPT{' '}
                <span className="ml-1.5 text-xs opacity-70">
                  {data.gptPrompt.length.toLocaleString('ru-RU')}
                </span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value={tab} forceMount>
              <textarea
                readOnly
                value={active}
                rows={20}
                className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="mt-1 text-[11px] text-muted-foreground">
                Длина активной вкладки: {active.length.toLocaleString('ru-RU')}{' '}
                символов.
              </div>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!data}
            onClick={() =>
              data &&
              void copy(
                tab === 'claude' ? data.claudePrompt : data.gptPrompt,
                tab,
              )
            }
          >
            {copiedId === tab
              ? '✓ Скопировано'
              : tab === 'claude'
                ? 'Copy — Клод'
                : 'Copy — GPT'}
          </Button>
          <Button
            variant="outline"
            disabled={!data}
            onClick={() => data && void copy(combined, 'all')}
            title="Скопировать оба промта целиком, с разделителем"
          >
            {copiedId === 'all' ? '✓ Скопировано всё' : 'Скопировать всё'}
          </Button>
          <Button onClick={onClose}>Закрыть</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────
// AccountsPage — главная страница
// ───────────────────────────────────────────────────────────────────────

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<GlobalSettings>({
    responsesPollDefaultSec: null,
    autoReplyText: null,
    telegramBotTokenMasked: null,
    telegramBotTokenSet: false,
    telegramChatId: null,
    notifyNewResponse: true,
    notifyAutoPause: true,
    notifyAccountDegraded: true,
    crmWebhookUrl: null,
    crmTokenMasked: null,
    crmTokenSet: false,
    crmNotifyLeadCreated: true,
    crmNotifyLeadPhone: true,
    crmNotifyLeadProcessed: true,
    crmNotifyAccountPaused: true,
    crmNotifyAccountDegraded: true,
    crmPullEnabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showGlobalModal, setShowGlobalModal] = useState(false);
  const [editReplyAccount, setEditReplyAccount] = useState<Account | null>(null);
  const [intervalAccount, setIntervalAccount] = useState<Account | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');
  const [detailAccount, setDetailAccount] = useState<Account | null>(null);
  const [contextAccount, setContextAccount] = useState<Account | null>(null);
  const [compact, setCompact] = useState<boolean>(true);

  useEffect(() => {
    try {
      const v = localStorage.getItem('accounts.compact');
      if (v === 'false') setCompact(false);
      else if (v === 'true') setCompact(true);
    } catch {
      /* private-mode — silently stay on default */
    }
  }, []);

  function setViewMode(c: boolean) {
    setCompact(c);
    try {
      localStorage.setItem('accounts.compact', String(c));
    } catch {
      /* ignore */
    }
  }

  async function load() {
    try {
      const [data, s] = await Promise.all([
        api<Account[]>('/accounts'),
        api<GlobalSettings>('/settings'),
      ]);
      setAccounts(data);
      setSettings(s);
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

  async function doAction(id: number, path: string) {
    setActingId(id);
    try {
      await api(`/accounts/${id}${path}`, { method: 'POST' });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }

  const withHealth = useMemo(
    () => accounts.map((a) => ({ a, h: computeAccountHealth(a) })),
    [accounts],
  );
  const filtered = useMemo(() => {
    if (healthFilter === 'all') return withHealth;
    if (healthFilter === 'problem') {
      return withHealth.filter((r) => r.h !== 'healthy');
    }
    return withHealth.filter((r) => r.h === healthFilter);
  }, [withHealth, healthFilter]);
  const counts = useMemo(() => {
    const c: Record<HealthFilter, number> = {
      all: withHealth.length,
      problem: 0,
      healthy: 0,
      degraded: 0,
      'auto-paused': 0,
    };
    for (const r of withHealth) {
      c[r.h]++;
      if (r.h !== 'healthy') c.problem++;
    }
    return c;
  }, [withHealth]);
  const signals = useMemo(() => {
    let retry = 0;
    let ip = 0;
    let login = 0;
    for (const { a } of withHealth) {
      if (a.retryRequired) retry++;
      if ((a.ipBlockedCount24h ?? 0) > 0) ip++;
      if ((a.loginRequiredCount24h ?? 0) > 0) login++;
    }
    return { retry, ip, login };
  }, [withHealth]);

  async function clearAutoPause(acc: Account) {
    if (!acc.autoPausedAt) return;
    const msg =
      `Снять авто-паузу с «${acc.name}»?\n\n` +
      `Причина: ${acc.autoPauseReason ?? 'unknown'}\n` +
      `Поставлена: ${fmt(acc.autoPausedAt)}\n\n` +
      `Аккаунт вернётся в расписание на следующем тике планировщика.`;
    if (!window.confirm(msg)) return;
    setActingId(acc.id);
    try {
      await api(`/accounts/${acc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          autoPausedAt: null,
          autoPauseReason: null,
        }),
      });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }

  async function remove(acc: Account) {
    const msg =
      `Удалить аккаунт «${acc.name}»?\n\n` +
      `Будут удалены:\n` +
      `  • все собранные отклики этого аккаунта\n` +
      `  • все попытки раскрытия телефонов\n` +
      `  • история snapshot'ов\n` +
      `  • папка Chromium-профиля на диске (${acc.profilePath})\n\n` +
      `История Activity Log сохранится для аудита.\n` +
      `Операция необратима.`;
    if (!window.confirm(msg)) return;
    setActingId(acc.id);
    try {
      await api(`/accounts/${acc.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      {/* PageContainer-эквивалент: padding + max-width + центровка.
          Других интеграций (Telegram / WhatsApp) обёрнуты в <PageContainer>,
          но он server-component — здесь page client-side, поэтому повторяем
          его классы inline. Без этого top-bar CRM визуально накрывает
          toolbar (контент прилипает к краям viewport'а). */}
      <main className="px-6 py-6 max-w-[1400px] mx-auto w-full pb-12">
      {/* ── WA-style шапка ──────────────────────────────────────── */}
      <div className="flex items-start gap-3 border-b pb-6 mb-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 mt-0.5">
          <Megaphone size={18} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Avito</h1>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            Chromium-профили для автоматического сбора откликов с кандидатов.
            Каждый новый отклик попадает в{' '}
            <a href="/leads/new" className="text-primary hover:underline">
              Новые лиды
            </a>{' '}
            и в{' '}
            <a href="/messages" className="text-primary hover:underline">
              Чаты
            </a>{' '}
            автоматически через webhook.
          </p>
        </div>
      </div>

      {/* ── Toolbar: density + global settings + add ────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Сегмент-контрол «Компактно / Подробно» — две shadcn Button
            с одинаковой высотой (h-9 size="sm"), склеенные по границе.
            Раньше был кастомный inline-flex с h-8, но он расходился
            с соседними кнопками по высоте и обрезался во flex-wrap. */}
        <div role="group" aria-label="Плотность таблицы" className="flex">
          <Button
            variant={compact ? 'default' : 'outline'}
            size="sm"
            className="rounded-r-none"
            onClick={() => setViewMode(true)}
            title="Компактный вид: одна строка на аккаунт, действия в виде иконок"
          >
            Компактно
          </Button>
          <Button
            variant={!compact ? 'default' : 'outline'}
            size="sm"
            className="rounded-l-none -ml-px"
            onClick={() => setViewMode(false)}
            title="Подробный вид: полные текстовые кнопки"
          >
            Подробно
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowGlobalModal(true)}
          title="Глобальный интервал + глобальный авто-ответ"
        >
          <SettingsIcon className="mr-1.5 h-4 w-4" /> Глобальные настройки
        </Button>
        <Button size="sm" onClick={() => setShowAddModal(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Добавить аккаунт
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Ошибка: {error}
        </div>
      )}
      {loading && accounts.length === 0 && (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      )}

      {/* ── Attention summary ───────────────────────────────────── */}
      {!loading && accounts.length > 0 && (
        <Card className="p-4 mb-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
            Требуют внимания
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex flex-wrap gap-2">
              <Chip className="bg-emerald-100 text-emerald-800 border-emerald-200">
                Норма: <strong>{counts.healthy}</strong>
              </Chip>
              <Chip className="bg-yellow-100 text-yellow-800 border-yellow-200">
                Сбои: <strong>{counts.degraded}</strong>
              </Chip>
              <Chip className="bg-red-100 text-red-800 border-red-200">
                Авто-пауза: <strong>{counts['auto-paused']}</strong>
              </Chip>
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip className="bg-muted text-foreground border-border">
                Требует повтора: <strong>{signals.retry}</strong>
              </Chip>
              <Chip className="bg-muted text-foreground border-border">
                IP заблокирован: <strong>{signals.ip}</strong>
              </Chip>
              <Chip className="bg-muted text-foreground border-border">
                Нужен вход: <strong>{signals.login}</strong>
              </Chip>
            </div>
            <div className="ml-auto">
              <Button
                size="sm"
                disabled={counts.problem === 0}
                onClick={() => setHealthFilter('problem')}
                title={
                  counts.problem === 0
                    ? 'Проблемных аккаунтов нет'
                    : 'Показать только аккаунты, требующие внимания'
                }
              >
                Показать только проблемные
                {counts.problem > 0 ? ` (${counts.problem})` : ''}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* ── Health filter tabs ──────────────────────────────────── */}
      <div role="tablist" aria-label="Health filter" className="flex flex-wrap gap-1.5 mb-3">
        {FILTER_TABS.map((t) => {
          const active = healthFilter === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'bg-foreground text-background border-foreground'
                  : 'border-border bg-background hover:bg-muted',
              )}
              onClick={() => setHealthFilter(t.key)}
            >
              {t.label}
              <span className={cn('text-xs', active ? 'opacity-90' : 'opacity-60')}>
                {counts[t.key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Accounts table ──────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <Th>#</Th>
                <Th>Название</Th>
                <Th>Телефон</Th>
                <Th>Статус</Th>
                <Th>Внимание</Th>
                <Th>Состояние</Th>
                <Th>Причина</Th>
                <Th>Что делать</Th>
                <Th>Интервал</Th>
                <Th>Последний сбор</Th>
                <Th>Действия</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ a: acc, h: health }) => {
                const intervalMin =
                  acc.responsesPollIntervalSec != null
                    ? Math.round(acc.responsesPollIntervalSec / 60)
                    : null;
                const att = computeAttention(acc);
                return (
                  <tr
                    key={acc.id}
                    className={cn(
                      'border-t border-border hover:bg-muted/30',
                      ATTENTION_ROW_TINT[att],
                    )}
                  >
                    <Td>{acc.id}</Td>
                    <Td>
                      <AccountFieldEditor
                        account={acc}
                        field="name"
                        label="название"
                        bold
                        maxLength={100}
                        onSaved={load}
                      />
                    </Td>
                    <Td>{acc.loginPhone ?? '—'}</Td>
                    <Td>
                      <Badge
                        variant="outline"
                        className={cn('border', STATUS_BADGE_CLASS[acc.status])}
                      >
                        {statusLabel(acc.status)}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge
                        variant="outline"
                        className={cn('border', ATTENTION_PILL_CLASS[att])}
                      >
                        {ATTENTION_LABEL[att]}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <button
                          className={cn(
                            'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold cursor-pointer hover:opacity-90',
                            HEALTH_BADGE_CLASS[health],
                          )}
                          title="Открыть подробности"
                          onClick={() => setDetailAccount(acc)}
                        >
                          {HEALTH_LABEL[health]}
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          title="Подробнее о состоянии"
                          aria-label="Подробнее о состоянии"
                          onClick={() => setDetailAccount(acc)}
                        >
                          <Info className="h-3 w-3" />
                        </Button>
                        {acc.retryRequired && (
                          <span
                            className="text-xs text-muted-foreground"
                            title="На последнем скане требовался retry. Снимется после успешного скана."
                          >
                            ↻
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td>{accountReason(acc)}</Td>
                    <Td>{accountAction(acc)}</Td>
                    <Td
                      title={
                        intervalMin != null
                          ? `Per-account override: ${acc.responsesPollIntervalSec}s`
                          : 'Используется глобальный'
                      }
                    >
                      {intervalMin != null ? (
                        <span>
                          <strong>{intervalMin}</strong>{' '}
                          <span className="text-muted-foreground">мин</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">глобальный</span>
                      )}
                    </Td>
                    <Td className="text-muted-foreground whitespace-nowrap">
                      {fmt(acc.lastCollectResponsesAt)}
                    </Td>
                    <Td>
                      {compact ? (
                        <CompactActions
                          acc={acc}
                          health={health}
                          actingId={actingId}
                          onAction={doAction}
                          onClearAutoPause={clearAutoPause}
                          onRemove={remove}
                          onOpenInterval={() => setIntervalAccount(acc)}
                          onOpenReply={() => setEditReplyAccount(acc)}
                          onOpenContext={() => setContextAccount(acc)}
                        />
                      ) : (
                        <ExpandedActions
                          acc={acc}
                          health={health}
                          actingId={actingId}
                          onAction={doAction}
                          onClearAutoPause={clearAutoPause}
                          onRemove={remove}
                          onOpenInterval={() => setIntervalAccount(acc)}
                          onOpenReply={() => setEditReplyAccount(acc)}
                          onOpenContext={() => setContextAccount(acc)}
                        />
                      )}
                    </Td>
                  </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    {accounts.length === 0
                      ? 'Аккаунтов пока нет. Нажмите «Добавить аккаунт».'
                      : `Нет аккаунтов в фильтре «${
                          FILTER_TABS.find((t) => t.key === healthFilter)?.label
                        }».`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── Modals ──────────────────────────────────────────────── */}
      <AddAccountModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={async () => {
          setShowAddModal(false);
          await load();
        }}
      />
      {editReplyAccount && (
        <EditAutoReplyModal
          account={editReplyAccount}
          open
          onClose={() => setEditReplyAccount(null)}
          onSaved={async () => {
            setEditReplyAccount(null);
            await load();
          }}
        />
      )}
      <GlobalSettingsModal
        settings={settings}
        accountCount={accounts.filter((a) => a.status !== 'paused').length}
        open={showGlobalModal}
        onClose={() => setShowGlobalModal(false)}
        onSaved={load}
      />
      {intervalAccount && (
        <EditIntervalModal
          account={intervalAccount}
          settings={settings}
          open
          onClose={() => setIntervalAccount(null)}
          onSaved={async () => {
            setIntervalAccount(null);
            await load();
          }}
        />
      )}
      {detailAccount && (
        <AccountHealthPopover
          account={detailAccount}
          open
          onClose={() => setDetailAccount(null)}
        />
      )}
      {contextAccount && (
        <ContextExportModal
          account={contextAccount}
          open
          onClose={() => setContextAccount(null)}
        />
      )}
      </main>
    </TooltipProvider>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Helper sub-components: table cells, action rows, chips
// ───────────────────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={cn('px-3 py-2 align-middle', className)} title={title}>
      {children}
    </td>
  );
}

function Chip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
        className,
      )}
    >
      {children}
    </span>
  );
}

interface ActionsProps {
  acc: Account;
  health: AccountHealth;
  actingId: number | null;
  onAction: (id: number, path: string) => void;
  onClearAutoPause: (acc: Account) => void;
  onRemove: (acc: Account) => void;
  onOpenInterval: () => void;
  onOpenReply: () => void;
  onOpenContext: () => void;
}

function CompactActions({
  acc,
  health,
  actingId,
  onAction,
  onClearAutoPause,
  onRemove,
  onOpenInterval,
  onOpenReply,
  onOpenContext,
}: ActionsProps) {
  return (
    <div className="flex items-center gap-1 flex-nowrap">
      <IconBtn
        title="Открыть Chromium с профилем этого аккаунта."
        ariaLabel="Открыть профиль"
        disabled={actingId === acc.id}
        onClick={() => onAction(acc.id, '/open-login-window')}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </IconBtn>
      <IconBtn
        title="Проверить что сессия жива и обновить статус."
        ariaLabel="Обновить статус"
        disabled={actingId === acc.id}
        onClick={() => onAction(acc.id, '/check-session')}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </IconBtn>
      <IconBtn
        title={
          acc.responsesPollIntervalSec !== null
            ? `Интервал — свой: ${Math.round(acc.responsesPollIntervalSec / 60)} мин`
            : 'Интервал — используется глобальный'
        }
        ariaLabel="Интервал сбора"
        onClick={onOpenInterval}
        dot={acc.responsesPollIntervalSec !== null}
      >
        <Timer className="h-3.5 w-3.5" />
      </IconBtn>
      <IconBtn
        title={
          acc.autoReplyText
            ? `Авто-ответ — свой: ${acc.autoReplyText.slice(0, 80)}${acc.autoReplyText.length > 80 ? '…' : ''}`
            : 'Авто-ответ — свой не задан'
        }
        ariaLabel="Авто-ответ"
        onClick={onOpenReply}
        dot={!!acc.autoReplyText}
      >
        <Mail className="h-3.5 w-3.5" />
      </IconBtn>
      {acc.autoPausedAt && (
        <IconBtn
          title={`Снять авто-паузу. Причина: ${acc.autoPauseReason ?? 'unknown'}.`}
          ariaLabel="Снять авто-паузу"
          disabled={actingId === acc.id}
          onClick={() => onClearAutoPause(acc)}
          className="text-emerald-700"
        >
          <Play className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      <IconBtn
        title="Открыть готовые промты для нового AI-чата (Claude / GPT)"
        ariaLabel="Разобрать с ИИ"
        onClick={onOpenContext}
        className={cn(health !== 'healthy' && 'ring-2 ring-amber-300 ring-offset-1')}
      >
        <Sparkles className="h-3.5 w-3.5" />
      </IconBtn>
      {acc.status !== 'paused' ? (
        <IconBtn
          title="Пауза — выключить автоматический сбор для этого аккаунта"
          ariaLabel="Пауза"
          disabled={actingId === acc.id}
          onClick={() => onAction(acc.id, '/pause')}
        >
          <Pause className="h-3.5 w-3.5" />
        </IconBtn>
      ) : (
        <IconBtn
          title="Возобновить автоматический сбор"
          ariaLabel="Возобновить"
          disabled={actingId === acc.id}
          onClick={() => onAction(acc.id, '/resume')}
          className="text-emerald-700"
        >
          <Play className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      <IconBtn
        title="Удалить аккаунт, все его отклики и Chromium-профиль на диске. Это необратимо."
        ariaLabel="Удалить"
        disabled={actingId === acc.id}
        onClick={() => onRemove(acc)}
        className="text-red-700 hover:bg-red-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </IconBtn>
    </div>
  );
}

function ExpandedActions({
  acc,
  health,
  actingId,
  onAction,
  onClearAutoPause,
  onRemove,
  onOpenInterval,
  onOpenReply,
  onOpenContext,
}: ActionsProps) {
  return (
    <div className="flex items-center gap-1.5 flex-nowrap">
      <Button
        variant="outline"
        size="sm"
        disabled={actingId === acc.id}
        onClick={() => onAction(acc.id, '/open-login-window')}
        title="Открыть Chromium с профилем этого аккаунта."
      >
        Открыть профиль
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={actingId === acc.id}
        onClick={() => onAction(acc.id, '/check-session')}
        title="Проверить что сессия жива и обновить статус."
      >
        Обновить статус
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenInterval}
        title={
          acc.responsesPollIntervalSec !== null
            ? `Свой интервал: ${Math.round(acc.responsesPollIntervalSec / 60)} мин`
            : 'Используется глобальный интервал'
        }
      >
        Интервал {acc.responsesPollIntervalSec !== null && '✓'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenReply}
        title={
          acc.autoReplyText
            ? `Свой авто-ответ: ${acc.autoReplyText.slice(0, 80)}${acc.autoReplyText.length > 80 ? '…' : ''}`
            : 'Свой авто-ответ не задан'
        }
      >
        Авто-ответ {acc.autoReplyText && '✓'}
      </Button>
      {acc.autoPausedAt && (
        <Button
          variant="outline"
          size="sm"
          disabled={actingId === acc.id}
          onClick={() => onClearAutoPause(acc)}
          title={`Снять авто-паузу. Причина: ${acc.autoPauseReason ?? 'unknown'}.`}
          className="text-emerald-700 font-semibold"
        >
          Снять авто-паузу
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenContext}
        title="Открыть готовые промты для AI-чата (Claude / GPT)"
        className={cn(
          health !== 'healthy' && 'ring-2 ring-amber-300 ring-offset-1',
        )}
      >
        Разобрать с ИИ
      </Button>
      {acc.status !== 'paused' ? (
        <IconBtn
          title="Пауза — выключить автоматический сбор для этого аккаунта"
          ariaLabel="Пауза"
          disabled={actingId === acc.id}
          onClick={() => onAction(acc.id, '/pause')}
        >
          <Pause className="h-3.5 w-3.5" />
        </IconBtn>
      ) : (
        <IconBtn
          title="Возобновить автоматический сбор"
          ariaLabel="Возобновить"
          disabled={actingId === acc.id}
          onClick={() => onAction(acc.id, '/resume')}
        >
          <Play className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      <IconBtn
        title="Удалить аккаунт. Это необратимо."
        ariaLabel="Удалить"
        disabled={actingId === acc.id}
        onClick={() => onRemove(acc)}
        className="text-red-700 hover:bg-red-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </IconBtn>
    </div>
  );
}

function IconBtn({
  children,
  title,
  ariaLabel,
  onClick,
  disabled,
  className,
  dot,
}: {
  children: React.ReactNode;
  title?: string;
  ariaLabel?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  dot?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
        className,
      )}
    >
      {children}
      {dot && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary"
        />
      )}
    </button>
  );
}
