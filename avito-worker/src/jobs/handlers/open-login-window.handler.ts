import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  accounts,
  activityLog,
  type Database,
  type Job,
} from '@avito/db';
import { DB_TOKEN } from '../../db/db.module';
import { BrowserRegistryService } from '../../playwright/browser-registry.service';

interface Payload {
  accountId: number;
}

@Injectable()
export class OpenLoginWindowHandler {
  private readonly logger = new Logger(OpenLoginWindowHandler.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(BrowserRegistryService) private readonly registry: BrowserRegistryService,
  ) {}

  async handle(job: Job): Promise<void> {
    const payload = (job.payloadJson ?? {}) as Partial<Payload>;
    const accountId = Number(payload.accountId);
    if (!accountId) {
      throw new Error('open_login_window: missing accountId in payload');
    }
    const [acc] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!acc) throw new Error(`Account ${accountId} not found`);

    const ctx = await this.registry.getOrCreate(accountId, acc.profilePath);
    const page = await this.registry.firstPage(ctx);
    await page.goto('https://www.avito.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    await this.db
      .update(accounts)
      .set({
        status: 'auth_pending',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));

    await this.db.insert(activityLog).values({
      entityType: 'account',
      entityId: String(accountId),
      action: 'open_login_window_ready',
      detailsJson: { profilePath: acc.profilePath },
    });

    this.logger.log(
      `login window opened for account ${accountId} (profile ${acc.profilePath})`,
    );
  }
}
