/**
 * collect_responses handler (STEP B2 skeleton — navigation + pageKind only).
 *
 * Opens the persistent Chrome context for the account, navigates to the
 * messenger unread view, classifies the page (same heuristic as
 * scan_account — profile_ok / ip_blocked / login_required / unknown),
 * and writes `collect_responses_done` with {unreadCount, pageKind}. On
 * success also stamps `accounts.last_collect_responses_at = now()` so
 * the B6 polling tick can compute "due for next collect" correctly.
 *
 * B2 does NOT parse the dialog list (unreadCount is best-effort via a
 * generic selector — it will be refined in B3 once the real DOM is
 * inspected on a live, unblocked account).
 *
 * Failure contract mirrors scan_account: on nav error → throw →
 * JobPoller marks the job as `failed` + `last_error`. `collect_responses_failed`
 * activity event logged separately. Browser context always released.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  activityLog,
  appSettings,
  phoneRevealAttempts,
  responses,
  type Database,
  type Job,
} from '@avito/db';
import { DB_TOKEN } from '../../db/db.module';
import { BrowserRegistryService } from '../../playwright/browser-registry.service';
import {
  debugMessengerDom,
  parseMessengerList,
  parseMessengerListMeta,
  scrollMessengerList,
  type MessengerDialogSummary,
} from '../../playwright/parse-messenger-list';
import {
  debugMessengerDialog,
  markDialogRead,
  parseMessengerDialog,
  parseMessengerDialogMeta,
} from '../../playwright/parse-messenger-dialog';
import { revealPhone } from '../../playwright/reveal-phone';
import { sendChatMessage } from '../../playwright/send-chat-message';
import {
  absoluteAvitoUrl,
  normalizePhoneCompact,
  readTgSettings,
  sendTg,
  type TgButton,
  type TgSettings,
} from '../../notifications/tg';
import {
  enqueueCrmEvent,
  readCrmSettings,
  type CrmSettings,
} from '../../notifications/crm';
import {
  makeCrmEnvelope,
  toCrmLeadDto,
  type CrmAccountAutoPausedDto,
  type CrmAccountDegradedDto,
} from '../../notifications/crm-dto';

interface Payload {
  accountId: number;
}

type PageKind = 'profile_ok' | 'login_required' | 'ip_blocked' | 'unknown';

const MESSENGER_URL = 'https://www.avito.ru/profile/messenger';

// Dev default matches the existing API_BASE_URL / WEB_PORT pattern.
// Override via env when the operator needs TG links reachable from a
// mobile device (localhost / 127.0.0.1 won't open there).
const WEB_BASE_URL = (process.env.WEB_BASE_URL ?? 'http://127.0.0.1:3000').replace(
  /\/+$/,
  '',
);

// Per-account dedupe for "⚠️ Требует действий" notifications. We keep
// this in-memory — same semantics as AccountSched (ephemeral by
// design, resets on worker restart). 30 minutes is long enough to
// avoid spamming the same `login_required` during a brief scheduler
// burst, short enough that a real sustained degraded state gets a
// second reminder within an hour.
const DEGRADED_NOTIFY_DEDUPE_MS = 30 * 60 * 1000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function classifyPage(finalUrl: string, title: string): PageKind {
  const titleLower = title.toLowerCase();
  const urlLower = finalUrl.toLowerCase();

  if (
    titleLower.includes('доступ ограничен') ||
    titleLower.includes('проблема с ip')
  ) {
    return 'ip_blocked';
  }
  if (
    urlLower.includes('/login') ||
    titleLower.includes('вход') ||
    titleLower.includes('авторизация')
  ) {
    return 'login_required';
  }
  if (urlLower.includes('/messenger') || urlLower.includes('/profile')) {
    return 'profile_ok';
  }
  return 'unknown';
}

@Injectable()
export class CollectResponsesHandler {
  private readonly logger = new Logger(CollectResponsesHandler.name);

  // Key: `${accountId}:${kind}` where kind ∈ 'login_required' |
  // 'ip_blocked'. Value: unix-ms of last TG send.
  private degradedDedupe: Map<string, number> = new Map();

  // CRM-side equivalent of degradedDedupe — separate Map so CRM can be
  // configured independently of TG. Same key shape; same semantics
  // (event_type + state are encoded in the key, dedupe only when the
  // same state persists within DEGRADED_NOTIFY_DEDUPE_MS).
  private crmDegradedDedupe: Map<string, number> = new Map();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(BrowserRegistryService)
    private readonly registry: BrowserRegistryService,
  ) {}

  async handle(job: Job): Promise<void> {
    const payload = (job.payloadJson ?? {}) as Partial<Payload>;
    const accountId = Number(payload.accountId);
    if (!accountId) {
      throw new Error('collect_responses: missing accountId in payload');
    }

    const [acc] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!acc) throw new Error(`Account ${accountId} not found`);

    // Resolve effective auto-reply text:
    //   1. per-account override on `acc.auto_reply_text`
    //   2. global fallback from app_settings (`auto_reply_default_text`)
    //   3. null → no auto-reply for this run
    // Read once at the top so we don't re-query per dialog. Best-effort:
    // on DB error, fall back to whatever per-account value we already have.
    let effectiveAutoReplyText: string | null =
      (acc.autoReplyText ?? '').trim() || null;
    if (!effectiveAutoReplyText) {
      try {
        const [row] = await this.db
          .select({ value: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, 'auto_reply_default_text'))
          .limit(1);
        const v = (row?.value ?? '').trim();
        effectiveAutoReplyText = v.length > 0 ? v : null;
      } catch {
        /* stay with null */
      }
    }

    // Read TG notification settings once per cycle. readTgSettings
    // swallows DB errors and returns all-false defaults, so TG is
    // automatically "off" when unconfigured or when the DB has a
    // hiccup — collect never fails because of TG.
    const tg: TgSettings = await readTgSettings(this.db);
    const tgActive =
      tg.botToken != null &&
      tg.chatId != null &&
      tg.botToken.length > 0 &&
      tg.chatId.length > 0;

    // Same pattern for CRM: one read per collect cycle, swallows DB
    // errors. crmActive = "configured enough to attempt". Per-event
    // notify_* flags are checked inside enqueueCrmEvent.
    const crm: CrmSettings = await readCrmSettings(this.db);
    const crmActive =
      crm.webhookUrl != null &&
      crm.token != null &&
      crm.webhookUrl.length > 0 &&
      crm.token.length > 0;

    await this.logActivity(accountId, 'collect_responses_started', {
      accountId,
    });
    this.logger.log(`collect_responses_started account=${accountId}`);

    // OBS1 — timers and counters for the fleet-health surface on
    // accounts. Computed over the lifetime of this collect cycle and
    // written at collect_responses_done time in a best-effort tail
    // UPDATE. Scoped outer so the phone reveal block (deep inside the
    // enrichment loop) can bump them.
    const startedAt = Date.now();
    let phoneSuccessCount = 0;
    let phoneFailedCount = 0;

    try {
      const wasAlreadyOpen = this.registry.get(accountId) !== undefined;
      const ctx = await this.registry.getOrCreate(accountId, acc.profilePath);
      const page = await this.registry.firstPage(ctx);

      let finalUrl = '';
      let title = '';
      let pageKind: PageKind = 'unknown';
      let unreadCount = 0;
      let summaries: MessengerDialogSummary[] = [];
      let navError: string | null = null;

      try {
        await page.goto(MESSENGER_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page
          .waitForLoadState('networkidle', { timeout: 10_000 })
          .catch(() => {
            this.logger.log(
              `collect_responses networkidle timed out (ok) account=${accountId}`,
            );
          });
        finalUrl = page.url();
        title = await page.title();
        pageKind = classifyPage(finalUrl, title);

        // B3 parse dialog list — pure DOM read via `parseMessengerList`.
        // Only attempted on profile_ok (other pageKinds mean the messenger
        // DOM isn't present). Parser never throws — returns [] on any issue.
        if (pageKind === 'profile_ok') {
          // B4 controlled scroll — ask Avito to lazy-load a few more
          // items before we parse. Bounded (≤3 iterations, 500ms each),
          // never throws. 0-iteration outcome is logged but non-fatal.
          const scrollIters = await scrollMessengerList(page);
          this.logger.log(
            `messenger scroll iterations account=${accountId}: ${scrollIters}`,
          );
          summaries = await parseMessengerList(page);
          const parserDbg =
            parseMessengerListMeta.lastError ??
            parseMessengerListMeta.lastDebug;
          if (parserDbg) {
            this.logger.log(
              `messenger parser diag account=${accountId}: ${parserDbg}`,
            );
          }
          unreadCount = summaries.filter((s) => s.isUnread).length;
          // Live-debug diagnostic: if parser returned nothing on a
          // profile_ok page, dump structural hints to the log so we can
          // see what Avito's real DOM looks like (selectors change
          // often). Removed once selectors stabilise.
          if (summaries.length === 0) {
            try {
              const diag = await debugMessengerDom(page);
              this.logger.warn(
                `messenger parser returned 0 dialogs account=${accountId} ` +
                  `anchors=${diag.anchorCount} messengerHrefs=${JSON.stringify(diag.anchorHrefs)} ` +
                  `markers=${JSON.stringify(diag.dataMarkerValues)}`,
              );
              this.logger.warn(
                `messenger bodyTextSample account=${accountId}: ${diag.bodyTextSample}`,
              );
              this.logger.warn(
                `messenger htmlSample account=${accountId}: ${diag.htmlSample}`,
              );
            } catch {
              /* diag is best-effort */
            }
          }
        }
      } catch (err) {
        navError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `collect_responses navigation error account=${accountId}: ${navError}`,
        );
      }

      // Close on nav error immediately (no upsert / enrichment to run)
      // to keep failure path symmetric with scan_account.
      if (navError) {
        if (!wasAlreadyOpen) {
          await this.registry.close(accountId);
        }
        throw new Error(navError);
      }

      // B3 persistence — upsert each unread dialog into `responses`. We
      // keep ONLY unread summaries; read dialogs (old messenger history)
      // are intentionally skipped per spec ("старые диалоги не смотрим").
      // New rows emit `response_collected`; existing rows are refreshed
      // silently so `isUnreadDetected` stays accurate without spamming
      // activity_log. Best-effort — any per-row error is logged and the
      // loop continues.
      let newCount = 0;
      let refreshedCount = 0;
      // Cap для refresh-mark-read: даже если в unread-листе много
      // старых диалогов (мы их уже видели и markRead'нули, но Avito
      // всё ещё показывает как непрочитанные — баг или лаг Avito UI),
      // не делаем больше N навигаций за цикл. 5 диалогов × ~7с/штука
      // = +35с к durationMs — в пределах PERF1 WARN-порога 60с.
      // Бэклог в 10+ диалогов чистится за 2-3 цикла.
      const MAX_REFRESH_MARK_READ_PER_CYCLE = 5;
      let refreshMarkedReadCount = 0;
      if (summaries.length > 0) {
        try {
          const existingRows = await this.db
            .select({ externalId: responses.externalId })
            .from(responses)
            .where(eq(responses.accountId, accountId));
          const existing = new Set(existingRows.map((r) => r.externalId));

          for (const s of summaries) {
            if (!s.isUnread) continue;

            // System-сообщения Avito (external_id вида `a2u-...`) —
            // это промо / рекомендации / системные нотификации, а не
            // отклики соискателей. Оператору они не нужны.
            // По спеке: заходим в диалог, помечаем прочитанным
            // (гигиена Avito UI), НИЧЕГО не пишем в `responses`.
            // Существующие a2u-* строки из прошлых тестов остаются
            // в БД (они всё равно скрыты из /responses UI фильтром
            // external_id NOT LIKE 'a2u-%') — не чистим их здесь.
            if (s.externalId.startsWith('a2u-')) {
              if (s.chatUrl) {
                try {
                  await page.goto(s.chatUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20_000,
                  });
                  await page
                    .waitForLoadState('networkidle', { timeout: 8_000 })
                    .catch(() => undefined);
                  await page
                    .waitForSelector(
                      '[data-marker*="message"], [class*="messageBubble"], time[datetime]',
                      { timeout: 6_000 },
                    )
                    .catch(() => undefined);
                  await markDialogRead(page);
                  this.logger.log(
                    `a2u hygiene mark-read account=${accountId} externalId=${s.externalId}`,
                  );
                } catch (err) {
                  this.logger.warn(
                    `a2u hygiene failed account=${accountId} externalId=${s.externalId}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }
              }
              continue; // не INSERT'им и не enrich'им
            }

            try {
              if (existing.has(s.externalId)) {
                // REFRESH PATH — intentionally narrow. List-level summary
                // is much lower quality than dialog-level enrichment:
                // the list often collapses name+title into one string.
                // If we write the list-level strings here, we overwrite
                // the GOOD values that B4 dialog enrichment stored when
                // the row was first inserted (this bit Савинков in
                // production — list kept putting item title into
                // candidate_name on every subsequent tick).
                //
                // So on refresh we touch ONLY: isUnreadDetected (signal
                // the dialog is still hot) + updatedAt. Everything else
                // — name, title, preview, phone, receivedAt — stays as
                // it was set during initial enrichment.
                await this.db
                  .update(responses)
                  .set({
                    isUnreadDetected: true,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(responses.accountId, accountId),
                      eq(responses.externalId, s.externalId),
                    ),
                  );
                refreshedCount++;

                // Mark-read для refresh path: при первом INSERT'е уже
                // вызывали markDialogRead, но Avito UI иногда показывает
                // диалог в unread-листе на следующем сборе (наш markRead
                // не закрепился, или Avito сдвинул индикатор обратно).
                // Здесь ловим этот хвост: повторно навигируем и
                // markRead'аем. Limit cap — чтобы не раздуть durationMs
                // когда у оператора 10+ старых unread-диалогов.
                if (
                  s.chatUrl &&
                  refreshMarkedReadCount < MAX_REFRESH_MARK_READ_PER_CYCLE
                ) {
                  try {
                    await page.goto(s.chatUrl, {
                      waitUntil: 'domcontentloaded',
                      timeout: 20_000,
                    });
                    await page
                      .waitForLoadState('networkidle', { timeout: 8_000 })
                      .catch(() => undefined);
                    await page
                      .waitForSelector(
                        '[data-marker*="message"], [class*="messageBubble"], time[datetime]',
                        { timeout: 6_000 },
                      )
                      .catch(() => undefined);
                    await markDialogRead(page);
                    refreshMarkedReadCount++;
                    this.logger.log(
                      `refresh mark-read account=${accountId} externalId=${s.externalId} ` +
                        `(${refreshMarkedReadCount}/${MAX_REFRESH_MARK_READ_PER_CYCLE})`,
                    );
                  } catch (err) {
                    this.logger.warn(
                      `refresh mark-read failed account=${accountId} externalId=${s.externalId}: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                }
              } else {
                const [inserted] = await this.db
                  .insert(responses)
                  .values({
                    accountId,
                    externalId: s.externalId,
                    externalIdSource: 'messenger_list',
                    chatHref: s.chatHref,
                    chatUrl: s.chatUrl,
                    candidateName: s.candidateName,
                    vacancyTitle: s.vacancyTitle,
                    preview: s.preview,
                    isUnreadDetected: true,
                    status: 'new',
                    rawDataJson: s as unknown as Record<string, unknown>,
                  })
                  .returning({ id: responses.id });
                newCount++;
                await this.logActivity(accountId, 'response_collected', {
                  accountId,
                  responseId: inserted.id,
                  externalId: s.externalId,
                  candidateName: s.candidateName,
                  vacancyTitle: s.vacancyTitle,
                });

                // B4 dialog enrichment — navigate into the freshly
                // inserted dialog and override the list-level summary
                // with the header-level truth (opponent name vs item
                // title separated, full last-message text, ISO
                // timestamp). Best-effort: nav error / parser miss /
                // DB failure does NOT roll back the row or fail the
                // job. On enrichment failure the list-level data
                // remains — still usable by the operator.
                if (s.chatUrl) {
                  try {
                    await page.goto(s.chatUrl, {
                      waitUntil: 'domcontentloaded',
                      timeout: 20_000,
                    });
                    await page
                      .waitForLoadState('networkidle', { timeout: 8_000 })
                      .catch(() => undefined);
                    // Extra settle for React-rendered message thread —
                    // domcontentloaded fires before the thread mounts.
                    await page
                      .waitForSelector(
                        '[data-marker*="message"], [class*="messageBubble"], [class*="MessageBubble"], time[datetime]',
                        { timeout: 6_000 },
                      )
                      .catch(() => undefined);
                    const details = await parseMessengerDialog(page);
                    // Broader DOM diagnostic: fires whenever the parser
                    // didn't get BOTH name AND a distinct (not-equal-to-
                    // vacancyTitle) name. This catches the "item_title
                    // leaked into name" pattern that we see on some
                    // employer dialogs (e.g. Савинков). Kept active
                    // during active debugging; tighten later.
                    const looksLikeFallback =
                      !details ||
                      !details.opponentName ||
                      (details.opponentName === details.itemTitle &&
                        details.itemTitle !== null);
                    if (looksLikeFallback) {
                      try {
                        const diag = await debugMessengerDialog(page);
                        this.logger.warn(
                          `dialog DOM diag account=${accountId} externalId=${s.externalId}: ${JSON.stringify(
                            diag,
                          ).slice(0, 4000)}`,
                        );
                      } catch {
                        /* diag is best-effort */
                      }
                    }
                    const dialogDbg =
                      parseMessengerDialogMeta.lastError ??
                      parseMessengerDialogMeta.lastDebug;
                    if (dialogDbg) {
                      this.logger.log(
                        `dialog parser account=${accountId} externalId=${s.externalId}: ${dialogDbg}`,
                      );
                    }
                    if (details) {
                      const receivedAt =
                        details.receivedAtIso &&
                        !Number.isNaN(
                          new Date(details.receivedAtIso).getTime(),
                        )
                          ? new Date(details.receivedAtIso)
                          : null;
                      // Merge list-summary + dialog-details into a
                      // single rawDataJson snapshot for debugging.
                      const mergedRaw: Record<string, unknown> = {
                        list: s as unknown as Record<string, unknown>,
                        dialog: details as unknown as Record<
                          string,
                          unknown
                        >,
                      };
                      await this.db
                        .update(responses)
                        .set({
                          candidateName:
                            details.opponentName ?? s.candidateName,
                          vacancyTitle:
                            details.itemTitle ?? s.vacancyTitle,
                          preview:
                            details.lastMessageText ?? s.preview,
                          receivedAt,
                          rawDataJson: mergedRaw,
                          updatedAt: new Date(),
                        })
                        .where(eq(responses.id, inserted.id));
                    }

                    // B5 phone reveal (Variant A — auto on every new
                    // unread response). Runs in the same navigated
                    // dialog page. Best-effort: failure here does not
                    // roll back the row nor fail the job. `attempt_no`
                    // is hard-coded to 1 because this is the first and
                    // only auto-attempt per new row — manual retries
                    // from the operator surface (future B7 endpoint)
                    // will bump it.
                    try {
                      const reveal = await revealPhone(page);
                      try {
                        await this.db.insert(phoneRevealAttempts).values({
                          responseId: inserted.id,
                          attemptNo: 1,
                          status: reveal.status,
                          clickedReveal: reveal.clickedReveal,
                          errorMessage: reveal.reason,
                        });
                      } catch (attErr) {
                        this.logger.warn(
                          `phone_reveal_attempts insert failed account=${accountId} responseId=${inserted.id}: ${
                            attErr instanceof Error
                              ? attErr.message
                              : String(attErr)
                          }`,
                        );
                      }
                      if (reveal.status === 'success' && reveal.phone) {
                        // OBS1 — cycle-level phone success counter.
                        phoneSuccessCount++;
                        await this.db
                          .update(responses)
                          .set({
                            phone: reveal.phone,
                            phoneRevealedAt: new Date(),
                            phoneRevealFailureReason: null,
                            status: 'phone_received',
                            updatedAt: new Date(),
                          })
                          .where(eq(responses.id, inserted.id));
                        await this.logActivity(
                          accountId,
                          'phone_revealed',
                          {
                            accountId,
                            responseId: inserted.id,
                            externalId: s.externalId,
                            phone: reveal.phone,
                          },
                        );
                        this.logger.log(
                          `phone_revealed account=${accountId} responseId=${inserted.id} phone=${reveal.phone}`,
                        );

                        // Auto-reply. Fires only if:
                        //   - effective auto-reply text is set (per-account
                        //     override OR global fallback from app_settings)
                        //   - phone reveal just succeeded (above `if`)
                        //   - this response row has no auto_reply_sent_at
                        //     yet (inserted row always does — this IS its
                        //     first and only auto-reply attempt)
                        // We stay on the same dialog page (already
                        // navigated there for enrichment+reveal), type
                        // the text, and send. Idempotency is enforced
                        // at the (account, external_id) level via the
                        // same unique constraint as responses — we'll
                        // never re-enter a new-insert path for an
                        // existing dialog.
                        const autoReplyText = effectiveAutoReplyText ?? '';
                        if (autoReplyText) {
                          try {
                            const sendRes = await sendChatMessage(
                              page,
                              autoReplyText,
                            );
                            if (sendRes.ok) {
                              await this.db
                                .update(responses)
                                .set({
                                  autoReplySentAt: new Date(),
                                  autoReplyStatus: 'sent',
                                  autoReplyError: null,
                                  updatedAt: new Date(),
                                })
                                .where(eq(responses.id, inserted.id));
                              await this.logActivity(
                                accountId,
                                'auto_reply_sent',
                                {
                                  accountId,
                                  responseId: inserted.id,
                                  externalId: s.externalId,
                                  textLength: autoReplyText.length,
                                },
                              );
                              this.logger.log(
                                `auto_reply_sent account=${accountId} responseId=${inserted.id}`,
                              );
                            } else {
                              await this.db
                                .update(responses)
                                .set({
                                  autoReplyStatus: 'failed',
                                  autoReplyError: sendRes.reason ?? null,
                                  updatedAt: new Date(),
                                })
                                .where(eq(responses.id, inserted.id));
                              await this.logActivity(
                                accountId,
                                'auto_reply_failed',
                                {
                                  accountId,
                                  responseId: inserted.id,
                                  externalId: s.externalId,
                                  reason: sendRes.reason,
                                },
                              );
                              this.logger.warn(
                                `auto_reply_failed account=${accountId} responseId=${inserted.id} reason=${JSON.stringify(sendRes.reason)}`,
                              );
                            }
                          } catch (err) {
                            this.logger.warn(
                              `auto_reply step crashed account=${accountId} responseId=${inserted.id}: ${
                                err instanceof Error
                                  ? err.message
                                  : String(err)
                              }`,
                            );
                          }
                        }
                      } else {
                        // OBS1 — cycle-level phone fail counter.
                        phoneFailedCount++;
                        await this.db
                          .update(responses)
                          .set({
                            phoneRevealFailureReason:
                              reveal.reason ?? reveal.status,
                            status: 'phone_failed',
                            updatedAt: new Date(),
                          })
                          .where(eq(responses.id, inserted.id));
                        await this.logActivity(
                          accountId,
                          'phone_reveal_failed',
                          {
                            accountId,
                            responseId: inserted.id,
                            externalId: s.externalId,
                            reason: reveal.status,
                            message: reveal.reason,
                          },
                        );
                        this.logger.warn(
                          `phone_reveal_failed account=${accountId} responseId=${inserted.id} status=${reveal.status} reason=${JSON.stringify(reveal.reason)}`,
                        );
                      }
                    } catch (err) {
                      this.logger.warn(
                        `phone reveal step crashed account=${accountId} externalId=${s.externalId}: ${
                          err instanceof Error
                            ? err.message
                            : String(err)
                        }`,
                      );
                    }

                    // Пометить диалог прочитанным в Avito. Простой
                    // page.goto на URL канала НЕ помечает — Avito
                    // ждёт явного взаимодействия с лентой сообщений
                    // (прокрутка к последнему + фокус input). Без
                    // этого у оператора в Avito UI диалог продолжает
                    // висеть непрочитанным, даже после того как мы
                    // собрали телефон и отправили авто-ответ.
                    //
                    // Если авто-ответ успешно отправлен — Avito
                    // обычно уже пометил диалог прочитанным по факту
                    // отправки нами сообщения. Но вызываем mark-read
                    // безусловно, чтобы покрыть и случаи без
                    // авто-ответа / без успешного reveal.
                    try {
                      await markDialogRead(page);
                    } catch (err) {
                      this.logger.warn(
                        `markDialogRead failed account=${accountId} externalId=${s.externalId}: ${
                          err instanceof Error ? err.message : String(err)
                        }`,
                      );
                    }

                    // TG notification #1 — "🆕 Новый лид". Fires only
                    // for freshly-INSERTED rows (refresh path does not
                    // reach this code). Phone may be null if reveal
                    // failed — shown as "не раскрыт" in that case.
                    // `telegramMessageId` is persisted so the API's
                    // mark-processed endpoint can edit this same
                    // message into "✅ Лид обработан" instead of
                    // posting a second message.
                    if (tgActive && tg.notifyNewResponse) {
                      try {
                        // Re-read the just-updated row so `phone` field
                        // reflects the reveal outcome (it was written
                        // a few awaits above).
                        const [fresh] = await this.db
                          .select({ phone: responses.phone })
                          .from(responses)
                          .where(eq(responses.id, inserted.id))
                          .limit(1);
                        const phoneCompact = normalizePhoneCompact(
                          fresh?.phone ?? null,
                        );
                        const phoneLine = phoneCompact
                          ? `📞 <code>${escapeHtml(phoneCompact)}</code>`
                          : '📞 не раскрыт';
                        const lines = [
                          '🆕 <b>Новый лид</b>',
                          phoneLine,
                          `Аккаунт: ${escapeHtml(acc.name)}`,
                        ];
                        const buttons: TgButton[] = [];
                        buttons.push({
                          text: 'Открыть в UI',
                          url: `${WEB_BASE_URL}/responses#response-${inserted.id}`,
                        });
                        const avitoUrl = absoluteAvitoUrl(s.chatUrl);
                        if (avitoUrl) {
                          buttons.push({
                            text: 'Открыть в Avito',
                            url: avitoUrl,
                          });
                        }
                        const messageId = await sendTg(
                          tg.botToken!,
                          tg.chatId!,
                          lines.join('\n'),
                          buttons,
                        );
                        if (messageId != null) {
                          await this.db
                            .update(responses)
                            .set({
                              telegramMessageId: messageId,
                              updatedAt: new Date(),
                            })
                            .where(eq(responses.id, inserted.id));
                        }
                      } catch (err) {
                        this.logger.warn(
                          `TG new-lead notify failed account=${accountId} responseId=${inserted.id}: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        );
                      }
                    }

                    // CRM event(s) — independent of TG. Always emits
                    // `lead.created`. If the enrichment phase already
                    // revealed a phone, ALSO emits `lead.phone_revealed`
                    // (as a separate envelope so CRM can route on
                    // phone-availability without inferring from
                    // status). Both go through the outbox; collect
                    // pipeline never blocks on CRM availability
                    // (3s cap inside enqueueCrmEvent).
                    if (crmActive) {
                      try {
                        const [respRow] = await this.db
                          .select()
                          .from(responses)
                          .where(eq(responses.id, inserted.id))
                          .limit(1);
                        if (respRow) {
                          const accountRef = { id: acc.id, name: acc.name };
                          await enqueueCrmEvent(
                            this.db,
                            this.logger,
                            crm,
                            makeCrmEnvelope(
                              'lead.created',
                              toCrmLeadDto(
                                respRow,
                                accountRef,
                                WEB_BASE_URL,
                                'new',
                              ),
                            ),
                          );
                          if (respRow.phone) {
                            await enqueueCrmEvent(
                              this.db,
                              this.logger,
                              crm,
                              makeCrmEnvelope(
                                'lead.phone_revealed',
                                toCrmLeadDto(
                                  respRow,
                                  accountRef,
                                  WEB_BASE_URL,
                                  'phone_received',
                                ),
                              ),
                            );
                          }
                        }
                      } catch (err) {
                        this.logger.warn(
                          `CRM lead notify failed account=${accountId} responseId=${inserted.id}: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        );
                      }
                    }
                  } catch (err) {
                    this.logger.warn(
                      `dialog enrichment failed account=${accountId} externalId=${s.externalId}: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                }
              }
            } catch (err) {
              this.logger.warn(
                `response upsert failed account=${accountId} externalId=${s.externalId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        } catch (err) {
          this.logger.warn(
            `response persistence failed account=${accountId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Close browser AFTER upsert + enrichment finished. Same
      // wasAlreadyOpen semantics as scan_account — never close a
      // context someone else (operator, other handler) opened.
      if (!wasAlreadyOpen) {
        await this.registry.close(accountId);
      }

      // OBS1 — extend the collect_responses_done payload with health
      // telemetry so any downstream consumer (activity log viewer,
      // future analytics) can reconstruct a cycle without joining
      // accounts + phone_reveal_attempts.
      const durationMs = Date.now() - startedAt;
      await this.logActivity(accountId, 'collect_responses_done', {
        accountId,
        url: finalUrl,
        title,
        pageKind,
        unreadCount,
        newCount,
        refreshedCount,
        durationMs,
        phoneSuccessCount,
        phoneFailedCount,
      });
      this.logger.log(
        `collect_responses_done account=${accountId} url=${finalUrl} title=${JSON.stringify(title)} pageKind=${pageKind} unreadCount=${unreadCount} new=${newCount} refreshed=${refreshedCount}`,
      );
      // OBS1 — one-line summary at INFO level, operator-friendly.
      this.logger.log(
        `collect summary: account=${accountId} pageKind=${pageKind} durationMs=${durationMs} newCount=${newCount} refreshedCount=${refreshedCount} phoneSuccessCount=${phoneSuccessCount} phoneFailedCount=${phoneFailedCount}`,
      );
      // PERF1 — silent-degradation guardrail. Cycles that take >60s
      // indicate one of: Avito slowed down, too many new dialogs to
      // enrich, network flaking, or a detection/throttling event. We
      // don't fail the job — just emit a WARN so the operator can
      // spot it in the log without a separate metrics platform.
      // Threshold is intentionally conservative (profile_ok cycles
      // normally finish in 15–45s). Raising this requires coordinated
      // updates in docs + operator runbooks, so keep it inline.
      if (durationMs > 60_000) {
        this.logger.warn(
          `slow collect job: accountId=${accountId} durationMs=${durationMs} ` +
            `newCount=${newCount} refreshedCount=${refreshedCount} ` +
            `phoneSuccessCount=${phoneSuccessCount} phoneFailedCount=${phoneFailedCount}`,
        );
      }

      // OBS1 — write fleet-health surface on accounts. Combines:
      //   1. Last-known cycle fields (always updated).
      //   2. `last_collect_responses_at` (was already here from B6).
      //   3. Rolling 24h counters with reset-on-stale semantics — if
      //      the paired *_updated_at is older than 24h, the counter
      //      resets to 1 on this increment; otherwise increments.
      //      Counters only increment on matching pageKind outcomes.
      // Best-effort: errors here do not flip the job from done → failed.
      try {
        const now = new Date();
        const DAY_MS = 24 * 60 * 60 * 1000;
        const needsReset = (ts: Date | null | undefined): boolean =>
          ts != null && now.getTime() - ts.getTime() > DAY_MS;

        const update: Partial<typeof accounts.$inferInsert> = {
          lastCollectResponsesAt: now,
          lastCollectPageKind: pageKind,
          lastCollectDurationMs: durationMs,
          lastCollectNewCount: newCount,
          lastCollectRefreshedCount: refreshedCount,
          lastCollectPhoneSuccessCount: phoneSuccessCount,
          lastCollectPhoneFailedCount: phoneFailedCount,
          updatedAt: now,
        };

        if (pageKind === 'ip_blocked') {
          update.ipBlockedCount24h = needsReset(acc.ipBlockedCountUpdatedAt)
            ? 1
            : (acc.ipBlockedCount24h ?? 0) + 1;
          update.ipBlockedCountUpdatedAt = now;
        }
        if (pageKind === 'login_required') {
          update.loginRequiredCount24h = needsReset(
            acc.loginRequiredCountUpdatedAt,
          )
            ? 1
            : (acc.loginRequiredCount24h ?? 0) + 1;
          update.loginRequiredCountUpdatedAt = now;
        }
        if (pageKind !== 'profile_ok') {
          update.collectFailCount24h = needsReset(acc.collectFailCountUpdatedAt)
            ? 1
            : (acc.collectFailCount24h ?? 0) + 1;
          update.collectFailCountUpdatedAt = now;
        }

        // FIX1 — a successful collect clears retryRequired. Previously
        // the flag could linger after a scan_account-level problem
        // even though the very next collect succeeded, keeping the
        // account permanently in OBS3 'degraded'. Spec is narrow: clear
        // ONLY on profile_ok, nothing else touched (no status change,
        // no activity_log event, no counter reset — that's either
        // separate logic above or deliberately not our concern here).
        if (pageKind === 'profile_ok') {
          update.retryRequired = false;
        }

        // OBS2 — fleet protection: auto-pause if counters cross
        // thresholds AND this account isn't already auto-paused.
        // Evaluates against the POST-increment values so the pause
        // triggers on the very cycle that crosses the threshold.
        // Only flips; never auto-unpauses (operator action required).
        const effFail =
          update.collectFailCount24h ?? acc.collectFailCount24h;
        const effIp = update.ipBlockedCount24h ?? acc.ipBlockedCount24h;
        const effLr =
          update.loginRequiredCount24h ?? acc.loginRequiredCount24h;
        const shouldAutoPause =
          acc.autoPausedAt == null &&
          (effFail >= 5 || effIp >= 3 || effLr >= 3);
        if (shouldAutoPause) {
          update.autoPausedAt = now;
          update.autoPauseReason = 'excessive_failures';
          this.logger.log(
            `account auto-paused: accountId=${accountId} ` +
              `reason=excessive_failures ` +
              `failCount=${effFail} ipBlockedCount=${effIp} loginRequiredCount=${effLr}`,
          );
        }

        await this.db
          .update(accounts)
          .set(update)
          .where(eq(accounts.id, accountId));

        // TG notification #2 — "⏸ Авто-пауза". Fires on the transition
        // cycle only (shouldAutoPause is guarded by `acc.autoPausedAt
        // == null`). Cleared auto-pauses do NOT re-trigger because
        // the guard will be false once the DB row is updated.
        if (shouldAutoPause && tgActive && tg.notifyAutoPause) {
          try {
            const lines = [
              '⏸ <b>Авто-пауза</b>',
              `Аккаунт: ${escapeHtml(acc.name)}`,
              `Причина: слишком много сбоев`,
              `Сбоев за сутки: ${effFail ?? 0} · IP-блоков: ${effIp ?? 0} · Нужен вход: ${effLr ?? 0}`,
              '→ снять паузу вручную после разбора',
            ];
            const buttons: TgButton[] = [
              {
                text: 'Открыть в UI',
                url: `${WEB_BASE_URL}/accounts`,
              },
            ];
            await sendTg(
              tg.botToken!,
              tg.chatId!,
              lines.join('\n'),
              buttons,
            );
          } catch (err) {
            this.logger.warn(
              `TG auto-pause notify failed account=${accountId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        // CRM event — account.auto_paused. Same transition guard as TG
        // (shouldAutoPause already implies acc.autoPausedAt was null).
        // Independent of TG flag; gated by crm.notifyAccountPaused
        // inside enqueueCrmEvent.
        if (shouldAutoPause && crmActive) {
          try {
            const data: CrmAccountAutoPausedDto = {
              account: { id: acc.id, name: acc.name },
              reason: 'excessive_failures',
              fail_24h: effFail ?? 0,
              ip_blocked_24h: effIp ?? 0,
              login_required_24h: effLr ?? 0,
              paused_at: now.toISOString(),
            };
            await enqueueCrmEvent(
              this.db,
              this.logger,
              crm,
              makeCrmEnvelope('account.auto_paused', data),
            );
          } catch (err) {
            this.logger.warn(
              `CRM auto-pause notify failed account=${accountId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        // TG notification #3 — "⚠️ Требует действий". Fires on
        // pageKind = login_required | ip_blocked. Dedupe per
        // (accountId, kind) for 30 min so a scheduler burst doesn't
        // flood the chat. Skipped if we already sent auto-pause this
        // cycle (the operator already has the critical signal).
        if (
          !shouldAutoPause &&
          tgActive &&
          tg.notifyAccountDegraded &&
          (pageKind === 'login_required' || pageKind === 'ip_blocked')
        ) {
          const dedupeKey = `${accountId}:${pageKind}`;
          const last = this.degradedDedupe.get(dedupeKey) ?? 0;
          if (Date.now() - last >= DEGRADED_NOTIFY_DEDUPE_MS) {
            this.degradedDedupe.set(dedupeKey, Date.now());
            try {
              const stateLabel =
                pageKind === 'login_required'
                  ? 'нужен повторный вход'
                  : 'IP заблокирован';
              const actionHint =
                pageKind === 'login_required'
                  ? '→ переавторизоваться в браузере'
                  : '→ сменить IP / прокси';
              const lines = [
                '⚠️ <b>Требует действий</b>',
                `Аккаунт: ${escapeHtml(acc.name)}`,
                `Состояние: ${stateLabel}`,
                `Сбоев за сутки: ${effFail ?? 0} · IP-блоков: ${effIp ?? 0} · Нужен вход: ${effLr ?? 0}`,
                actionHint,
              ];
              const buttons: TgButton[] = [
                {
                  text: 'Открыть в UI',
                  url: `${WEB_BASE_URL}/accounts`,
                },
              ];
              await sendTg(
                tg.botToken!,
                tg.chatId!,
                lines.join('\n'),
                buttons,
              );
            } catch (err) {
              this.logger.warn(
                `TG degraded notify failed account=${accountId} kind=${pageKind}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }

        // CRM event — account.degraded. Same trigger as TG #3 but its
        // own dedupe Map (CRM may be enabled without TG and vice versa).
        // Dedupe key encodes (accountId, event_type, state) so a
        // login_required → ip_blocked transition fires immediately
        // even if either state was sent <30 min ago.
        if (
          !shouldAutoPause &&
          crmActive &&
          (pageKind === 'login_required' || pageKind === 'ip_blocked')
        ) {
          const dedupeKey = `${accountId}:account.degraded:${pageKind}`;
          const last = this.crmDegradedDedupe.get(dedupeKey) ?? 0;
          if (Date.now() - last >= DEGRADED_NOTIFY_DEDUPE_MS) {
            this.crmDegradedDedupe.set(dedupeKey, Date.now());
            try {
              const data: CrmAccountDegradedDto = {
                account: { id: acc.id, name: acc.name },
                state: pageKind,
                fail_24h: effFail ?? 0,
                ip_blocked_24h: effIp ?? 0,
                login_required_24h: effLr ?? 0,
                observed_at: now.toISOString(),
              };
              await enqueueCrmEvent(
                this.db,
                this.logger,
                crm,
                makeCrmEnvelope('account.degraded', data),
              );
            } catch (err) {
              this.logger.warn(
                `CRM degraded notify failed account=${accountId} kind=${pageKind}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `health update failed account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logActivity(accountId, 'collect_responses_failed', {
        accountId,
        error: msg,
      });
      this.logger.warn(`collect_responses_failed account=${accountId}: ${msg}`);
      throw err;
    }
  }

  private async logActivity(
    accountId: number,
    action:
      | 'collect_responses_started'
      | 'collect_responses_done'
      | 'collect_responses_failed'
      | 'response_collected'
      | 'phone_revealed'
      | 'phone_reveal_failed'
      | 'auto_reply_sent'
      | 'auto_reply_failed',
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(activityLog).values({
        entityType: 'account',
        entityId: String(accountId),
        action,
        detailsJson: details,
      });
    } catch (err) {
      this.logger.warn(
        `activity_log insert failed account=${accountId} action=${action}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
