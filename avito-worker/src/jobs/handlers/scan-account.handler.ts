/**
 * scan_account handler (foundation — no parsing, no business extraction).
 *
 * Opens the persistent Chrome context for the account, navigates to /profile,
 * waits for the page to settle (best-effort), then closes (if we opened it).
 * Records three activity_log events: started / done / failed.
 *
 * Failure contract: on error, throw — JobPollerService will mark the job as
 * `failed` and set `last_error`. Activity log gets `scan_account_failed`
 * separately. Browser context is always released in finally.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import {
  accounts,
  accountSnapshot,
  activityLog,
  type Database,
  type Job,
} from '@avito/db';
import { DB_TOKEN } from '../../db/db.module';
import { BrowserRegistryService } from '../../playwright/browser-registry.service';
import {
  extractProfileSignals,
  type ProfileType,
} from '../../playwright/profile-signals-extractor';

interface Payload {
  accountId: number;
}

type PageKind = 'profile_ok' | 'login_required' | 'ip_blocked' | 'unknown';

type NextAction = 'proceed' | 'reauth' | 'retry_later' | 'inspect';

// Operational signal for downstream orchestration. Uses ONLY finalUrl and
// page.title() — no DOM parsing, no selectors, no network interception.
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
  if (urlLower.includes('/profile')) {
    return 'profile_ok';
  }
  return 'unknown';
}

// Advisory signal only.
// This value is written to activity_log but does not trigger
// any automatic actions, retries, or state changes.
function decideNextAction(pageKind: PageKind): NextAction {
  switch (pageKind) {
    case 'profile_ok':
      return 'proceed';
    case 'login_required':
      return 'reauth';
    case 'ip_blocked':
      return 'retry_later';
    case 'unknown':
      return 'inspect';
    default:
      return 'inspect';
  }
}

// STEP 6 retry readiness — pure mapping, no scheduling or automation.
// profile_ok clears the flag; every other recognised scan outcome sets it.
// Purely advisory state flag; the value does NOT trigger any retry.
function retryRequiredForPageKind(pageKind: PageKind): boolean {
  return pageKind !== 'profile_ok';
}

// STEP 18 attention severity — pure mapping for operator surface.
// login_required → high, ip_blocked → medium, unknown → low,
// profile_ok → null (no attention needed).
function attentionSeverityForPageKind(pageKind: PageKind): string | null {
  switch (pageKind) {
    case 'login_required':
      return 'high';
    case 'ip_blocked':
      return 'medium';
    case 'unknown':
      return 'low';
    case 'profile_ok':
      return null;
    default:
      return null;
  }
}

@Injectable()
export class ScanAccountHandler {
  private readonly logger = new Logger(ScanAccountHandler.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(BrowserRegistryService) private readonly registry: BrowserRegistryService,
  ) {}

  async handle(job: Job): Promise<void> {
    const payload = (job.payloadJson ?? {}) as Partial<Payload>;
    const accountId = Number(payload.accountId);
    if (!accountId) {
      throw new Error('scan_account: missing accountId in payload');
    }

    const [acc] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!acc) throw new Error(`Account ${accountId} not found`);

    await this.logActivity(accountId, 'scan_account_started', { accountId });
    this.logger.log(`scan_account_started account=${accountId}`);

    // Outer try/catch: guarantees a scan_account_failed entry for any failure
    // (launch / navigation / close). Throws on to JobPoller so job → failed.
    try {
      // Lifecycle mirrors CheckSessionHandler exactly:
      // wasAlreadyOpen / getOrCreate / firstPage live OUTSIDE the nav try/catch.
      // Close runs at the end, NOT in a finally.
      const wasAlreadyOpen = this.registry.get(accountId) !== undefined;
      const ctx = await this.registry.getOrCreate(accountId, acc.profilePath);
      const page = await this.registry.firstPage(ctx);

      let finalUrl = '';
      let title = '';
      let pageKind: PageKind = 'unknown';
      let heading = '';
      let nextAction: NextAction = 'inspect';
      let itemsCount: number | null = null;
      let accountName = '';
      let profileType: ProfileType = 'unknown';
      let navError: string | null = null;
      try {
        await page.goto('https://www.avito.ru/profile', {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page
          .waitForLoadState('networkidle', { timeout: 10_000 })
          .catch(() => {
            this.logger.log(
              `scan_account networkidle timed out (ok) account=${accountId}`,
            );
          });
        finalUrl = page.url();
        // Minimal extraction step: page title only. Empty string is fine
        // (recorded as-is, not treated as failure).
        title = await page.title();
        pageKind = classifyPage(finalUrl, title);
        nextAction = decideNextAction(pageKind);

        // Best-effort DOM signal: first <h1> textContent. Own try/catch —
        // missing h1 / timeout / detached node / context closure here MUST NOT
        // turn a successful navigation into scan_account_failed.
        try {
          const raw = await page
            .locator('h1')
            .first()
            .textContent({ timeout: 1000 });
          const trimmed = (raw ?? '').trim();
          heading = trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
        } catch {
          heading = '';
        }

        // Business signals — only on profile_ok. Own try/catch; extractor
        // itself never throws, but stay defensive. On any issue values stay
        // neutral (null / "" / "unknown") and scan proceeds as done.
        if (pageKind === 'profile_ok') {
          try {
            const signals = await extractProfileSignals(page);
            itemsCount = signals.itemsCount;
            accountName = signals.accountName;
            profileType = signals.profileType;
          } catch (err) {
            this.logger.warn(
              `profile signals extraction failed account=${accountId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        navError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `scan navigation error account=${accountId}: ${navError}`,
        );
      }

      // Same close rule as CheckSessionHandler: only close if we opened it.
      if (!wasAlreadyOpen) {
        await this.registry.close(accountId);
      }

      if (navError) {
        // Surface nav failure to the outer catch → scan_account_failed + rethrow.
        throw new Error(navError);
      }

      await this.logActivity(accountId, 'scan_account_done', {
        accountId,
        url: finalUrl,
        title,
        pageKind,
        heading,
        nextAction,
        itemsCount,
        accountName,
        profileType,
      });
      this.logger.log(
        `scan_account_done account=${accountId} url=${finalUrl} title=${JSON.stringify(title)} pageKind=${pageKind} heading=${JSON.stringify(heading)} nextAction=${nextAction} itemsCount=${itemsCount} accountName=${JSON.stringify(accountName)} profileType=${profileType}`,
      );

      // Snapshot persistence — non-critical tail step. Runs ONLY on success
      // path (after scan_account_done is logged), never on nav failure.
      // Insert error is swallowed: scan job must still complete as `done`.
      try {
        const inserted = await this.db
          .insert(accountSnapshot)
          .values({
            accountId,
            capturedAt: new Date(),
            pageKind,
            heading,
            nextAction,
            itemsCount,
            accountName,
            profileType,
          })
          .returning({ id: accountSnapshot.id });

        // STEP 3 change detection — best-effort overlay on top of the
        // just-persisted snapshot. Runs ONLY after a successful insert so
        // `newId` is real. Own try/catch keeps scan_account_done intact
        // regardless of lookup/insert failures downstream.
        const newId = inserted[0]?.id;
        if (typeof newId === 'number') {
          try {
            await this.detectAndLogSnapshotChanges({
              accountId,
              newId,
              currentPageKind: pageKind,
              currentItemsCount: itemsCount,
            });
          } catch (err) {
            this.logger.warn(
              `snapshot_changed detection failed account=${accountId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        this.logger.warn(
          `account_snapshot insert failed account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // STEP 6 retry readiness — best-effort tail step. Runs ONLY on the
      // successful scan path (after scan_account_done is logged). Idempotent:
      // writes to accounts + emits retry_state_updated activity_log entry
      // ONLY when the desired value differs from the current one. Errors are
      // swallowed with a warn; scan job must still complete as `done`.
      //
      // NOTE: no retry/scheduler/automation is triggered by this state — the
      // column is a passive operator-facing signal, nothing else reads it.
      try {
        const desired = retryRequiredForPageKind(pageKind);
        const current = acc.retryRequired;
        if (desired !== current) {
          await this.db
            .update(accounts)
            .set({ retryRequired: desired, updatedAt: new Date() })
            .where(eq(accounts.id, accountId));
          await this.logActivity(accountId, 'retry_state_updated', {
            accountId,
            retryRequired: desired,
            reason: pageKind,
          });
          this.logger.log(
            `retry_state_updated account=${accountId} retryRequired=${desired} reason=${pageKind}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `retry_state_updated failed account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // STEP 7 operator visibility — best-effort tail step. Runs on every
      // successful scan, unconditionally (no diff, no activity_log emit).
      // Surfaces last-scan facts on the accounts row so `GET /accounts` is
      // enough for operators without joining activity_log. Errors are
      // swallowed with a warn; scan job must still complete as `done`.
      try {
        const now = new Date();
        await this.db
          .update(accounts)
          .set({
            lastScanAt: now,
            lastScanPageKind: pageKind,
            lastScanReason: pageKind,
            lastScanNextAction: nextAction,
            lastError: null, // STEP 16 — clear on success
            lastSuccessAt: now, // STEP 17 — stamp success time
            attentionSeverity: attentionSeverityForPageKind(pageKind), // STEP 18
            updatedAt: now,
          })
          .where(eq(accounts.id, accountId));
      } catch (err) {
        this.logger.warn(
          `last_scan visibility update failed account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // STEP 10 manual-retry outcome — best-effort tail step. ONLY flips
      // last_manual_retry_outcome when THIS job IS the account's current
      // last_manual_retry_job_id (set by the /retry endpoint). A regular
      // (non-retry) scan must NOT overwrite the last manual-retry outcome
      // — the spec explicitly forbids that. Errors are swallowed: scan
      // job must still complete as `done`.
      if (acc.lastManualRetryJobId === job.id) {
        try {
          await this.db
            .update(accounts)
            .set({
              lastManualRetryOutcome: pageKind,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, accountId));
        } catch (err) {
          this.logger.warn(
            `last_manual_retry_outcome update failed account=${accountId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // STEP 14 reauth requirement detection — best-effort tail step.
      // Surfaces the "account needs manual relogin" signal on the
      // `reauth_required_at` column: set to now() on first observation of
      // login_required (only if currently null — preserves the original
      // moment); cleared on profile_ok (only if currently non-null —
      // idempotent). Any other pageKind leaves the field untouched.
      // Errors are swallowed; scan remains `done`.
      try {
        if (pageKind === 'login_required' && acc.reauthRequiredAt === null) {
          const now = new Date();
          await this.db
            .update(accounts)
            .set({ reauthRequiredAt: now, updatedAt: now })
            .where(eq(accounts.id, accountId));
          this.logger.log(
            `reauth_required_at set account=${accountId} at=${now.toISOString()}`,
          );
        } else if (
          pageKind === 'profile_ok' &&
          acc.reauthRequiredAt !== null
        ) {
          const now = new Date();
          await this.db
            .update(accounts)
            .set({ reauthRequiredAt: null, updatedAt: now })
            .where(eq(accounts.id, accountId));
          this.logger.log(
            `reauth_required_at cleared account=${accountId} (profile_ok)`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `reauth_required_at update failed account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // STEP 13 acknowledge reset on state change — best-effort tail step.
      // If the observed state (pageKind or nextAction) differs from the
      // pre-scan state AND the account was previously acknowledged, clear
      // `acknowledged_at` so the account re-appears in the attention queue
      // with the new signal. Pre-scan values are read from `acc`, which
      // was SELECTed at the start of handle() before any updates.
      // No-op if: (a) state did not change, or (b) account was not
      // acknowledged. Errors are swallowed; scan remains `done`.
      try {
        const stateChanged =
          acc.lastScanPageKind !== pageKind ||
          acc.lastScanNextAction !== nextAction;
        if (stateChanged && acc.acknowledgedAt !== null) {
          await this.db
            .update(accounts)
            .set({ acknowledgedAt: null, updatedAt: new Date() })
            .where(eq(accounts.id, accountId));
          this.logger.log(
            `acknowledgement reset account=${accountId} prevPageKind=${acc.lastScanPageKind} currPageKind=${pageKind} prevNextAction=${acc.lastScanNextAction} currNextAction=${nextAction}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `acknowledgement reset failed account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logActivity(accountId, 'scan_account_failed', {
        accountId,
        error: msg,
      });
      this.logger.warn(`scan_account_failed account=${accountId}: ${msg}`);
      // STEP 16 last-error tracking — best-effort write in the failure
      // path. Records the final scan error on the account row so
      // operators can read it from GET /accounts without digging into
      // activity_log. Failure here is swallowed and we rethrow `err`
      // below to preserve job failure semantics.
      try {
        await this.db
          .update(accounts)
          .set({ lastError: msg, updatedAt: new Date() })
          .where(eq(accounts.id, accountId));
      } catch (dbErr) {
        this.logger.warn(
          `last_error update failed account=${accountId}: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
      }
      throw err;
    }
  }

  private async logActivity(
    accountId: number,
    action:
      | 'scan_account_started'
      | 'scan_account_done'
      | 'scan_account_failed'
      | 'snapshot_changed'
      | 'retry_state_updated',
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
        `activity_log insert failed action=${action} account=${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // STEP 3 change detection. Looks up the nearest previous snapshot for
  // the same account (id < newId, order by id desc, limit 1). Compares
  // ONLY pageKind and itemsCount. Emits one `snapshot_changed` activity_log
  // entry per changed field — never batched into a single diff object.
  // First snapshot (no previous row) → silent no-op. Caller wraps this in
  // try/catch so errors never affect scan_account_done.
  private async detectAndLogSnapshotChanges(args: {
    accountId: number;
    newId: number;
    currentPageKind: PageKind;
    currentItemsCount: number | null;
  }): Promise<void> {
    const { accountId, newId, currentPageKind, currentItemsCount } = args;

    const previousRows = await this.db
      .select({
        pageKind: accountSnapshot.pageKind,
        itemsCount: accountSnapshot.itemsCount,
      })
      .from(accountSnapshot)
      .where(
        and(
          eq(accountSnapshot.accountId, accountId),
          lt(accountSnapshot.id, newId),
        ),
      )
      .orderBy(desc(accountSnapshot.id))
      .limit(1);

    if (previousRows.length === 0) return;
    const prev = previousRows[0];

    if (prev.pageKind !== currentPageKind) {
      await this.logActivity(accountId, 'snapshot_changed', {
        accountId,
        field: 'pageKind',
        from: prev.pageKind,
        to: currentPageKind,
      });
      this.logger.log(
        `snapshot_changed account=${accountId} field=pageKind from=${prev.pageKind} to=${currentPageKind}`,
      );
    }

    if (prev.itemsCount !== currentItemsCount) {
      await this.logActivity(accountId, 'snapshot_changed', {
        accountId,
        field: 'itemsCount',
        from: prev.itemsCount,
        to: currentItemsCount,
      });
      this.logger.log(
        `snapshot_changed account=${accountId} field=itemsCount from=${prev.itemsCount} to=${currentItemsCount}`,
      );
    }
  }
}
