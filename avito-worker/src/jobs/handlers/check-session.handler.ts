import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Page } from 'playwright';
import {
  accounts,
  activityLog,
  type Account,
  type Database,
  type Job,
} from '@avito/db';
import type { AccountStatus } from '@avito/shared';
import { DB_TOKEN } from '../../db/db.module';
import { BrowserRegistryService } from '../../playwright/browser-registry.service';
import { extractStableId } from '../../playwright/stable-id-extractor';

interface Payload {
  accountId: number;
}

@Injectable()
export class CheckSessionHandler {
  private readonly logger = new Logger(CheckSessionHandler.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(BrowserRegistryService) private readonly registry: BrowserRegistryService,
  ) {}

  async handle(job: Job): Promise<void> {
    const payload = (job.payloadJson ?? {}) as Partial<Payload>;
    const accountId = Number(payload.accountId);
    if (!accountId) {
      throw new Error('check_session: missing accountId in payload');
    }
    const [acc] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!acc) throw new Error(`Account ${accountId} not found`);

    const wasAlreadyOpen = this.registry.get(accountId) !== undefined;
    const ctx = await this.registry.getOrCreate(accountId, acc.profilePath);
    const page = await this.registry.firstPage(ctx);

    // TODO(stable-id-spike): Replace URL-only heuristic with a robust check
    // (DOM/network probe) once PROMPT 2 finalizes selectors and signals.
    let finalUrl = '';
    let heuristicError: string | null = null;
    try {
      await page.goto('https://www.avito.ru/profile', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      finalUrl = page.url();
    } catch (err) {
      heuristicError = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `navigation error while checking session for ${accountId}: ${heuristicError}`,
      );
    }

    const looksLoggedOut = /\/login|\/auth|\/register|\/profile\/login/i.test(
      finalUrl,
    );
    const nextStatus: AccountStatus = heuristicError
      ? 'error'
      : looksLoggedOut
        ? 'reauth_required'
        : 'active';

    const now = new Date();
    await this.db
      .update(accounts)
      .set({
        status: nextStatus,
        lastAuthAt: nextStatus === 'active' ? now : acc.lastAuthAt,
        reauthRequiredAt:
          nextStatus === 'reauth_required' ? now : acc.reauthRequiredAt,
        lastError: heuristicError,
        updatedAt: now,
      })
      .where(eq(accounts.id, accountId));

    await this.db.insert(activityLog).values({
      entityType: 'account',
      entityId: String(accountId),
      action: 'check_session_result',
      detailsJson: {
        status: nextStatus,
        finalUrl,
        heuristicError,
        note: 'URL-only heuristic; refine after stable-id spike',
      },
    });

    this.logger.log(
      `check_session account=${accountId} status=${nextStatus} finalUrl=${finalUrl}`,
    );

    // Best-effort tail: stable-id extraction only on successful auth.
    // Any failure inside is swallowed — auth flow must not break.
    if (nextStatus === 'active') {
      try {
        await this.applyStableId(accountId, page, acc);
      } catch (err) {
        this.logger.warn(
          `applyStableId threw (swallowed) account=${accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!wasAlreadyOpen) {
      await this.registry.close(accountId);
    }
  }

  private async applyStableId(
    accountId: number,
    page: Page,
    acc: Account,
  ): Promise<void> {
    let extracted: Awaited<ReturnType<typeof extractStableId>> = null;
    try {
      extracted = await extractStableId(page);
    } catch (err) {
      // extractStableId itself swallows errors, but stay defensive.
      this.logger.warn(
        `stable_id extract threw account=${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // not found
    if (!extracted) {
      await this.logStableIdActivity(accountId, 'stable_id_not_found', {});
      this.logger.log(`stable_id_not_found account=${accountId}`);
      return;
    }

    const now = new Date();

    // first successful extraction
    if (!acc.stableId) {
      await this.db
        .update(accounts)
        .set({
          stableId: extracted.value,
          stableIdSource: extracted.source,
          stableIdUpdatedAt: now,
        })
        .where(eq(accounts.id, accountId));
      await this.logStableIdActivity(accountId, 'stable_id_extracted', {
        value: extracted.value,
        source: extracted.source,
      });
      this.logger.log(
        `stable_id_extracted account=${accountId} value=${extracted.value} source=${extracted.source}`,
      );
      return;
    }

    // match — refresh timestamp only
    if (acc.stableId === extracted.value) {
      await this.db
        .update(accounts)
        .set({ stableIdUpdatedAt: now })
        .where(eq(accounts.id, accountId));
      await this.logStableIdActivity(accountId, 'stable_id_extracted', {
        value: extracted.value,
        source: extracted.source,
      });
      this.logger.log(
        `stable_id_extracted (match) account=${accountId} value=${extracted.value}`,
      );
      return;
    }

    // mismatch — DO NOT overwrite, DO NOT change status, only signal
    await this.logStableIdActivity(accountId, 'stable_id_mismatch', {
      expected: acc.stableId,
      got: extracted.value,
      source: extracted.source,
    });
    this.logger.warn(
      `stable_id_mismatch account=${accountId} expected=${acc.stableId} got=${extracted.value} source=${extracted.source}`,
    );
  }

  private async logStableIdActivity(
    accountId: number,
    action: 'stable_id_extracted' | 'stable_id_not_found' | 'stable_id_mismatch',
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
      // swallow — activity log failure must not break auth flow
      this.logger.warn(
        `activity_log insert failed action=${action} account=${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
