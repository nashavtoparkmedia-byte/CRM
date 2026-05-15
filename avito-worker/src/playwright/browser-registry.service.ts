import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { chromium, type BrowserContext, type Page } from 'playwright';

// FS8 — minimal browser hardening. Removes the single most obvious
// automation signal (`navigator.webdriver === true`) without pulling
// in a stealth framework. Applied as an init script on every new
// context so every page in the context inherits it before any site
// JS runs.
//
// Intentionally narrow: we don't fake user-agent / plugins / language /
// canvas / WebGL / codec fingerprints. Those extensions belong in a
// dedicated stealth layer if we ever decide we need one, and each
// additional shim is another detectable surface. For MVP the only
// goal is to stop a naive `navigator.webdriver` check from flagging
// the session as automated.
const WEBDRIVER_INIT_SCRIPT = `
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_e) {
    // Silently swallow — if the getter is already shimmed by a future
    // Chrome build, leaving it alone is safer than throwing in init.
  }
`;

@Injectable()
export class BrowserRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserRegistryService.name);
  private readonly contexts = new Map<number, BrowserContext>();

  async getOrCreate(accountId: number, profilePath: string): Promise<BrowserContext> {
    const existing = this.contexts.get(accountId);
    if (existing) return existing;

    this.logger.log(
      `launching persistent context for account ${accountId} at ${profilePath}`,
    );
    const ctx = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: null,
      channel: 'chrome',
      args: ['--start-maximized'],
    });
    // FS8 — inject hardening before site JS runs. One-shot per context.
    // addInitScript propagates to every page opened in this context,
    // including pages already open (Playwright applies it on next nav).
    try {
      await ctx.addInitScript(WEBDRIVER_INIT_SCRIPT);
    } catch (err) {
      this.logger.warn(
        `failed to inject FS8 init script for account ${accountId}: ${String(err)}`,
      );
    }
    this.contexts.set(accountId, ctx);
    ctx.on('close', () => {
      this.logger.log(`context closed for account ${accountId}`);
      this.contexts.delete(accountId);
    });
    return ctx;
  }

  get(accountId: number): BrowserContext | undefined {
    return this.contexts.get(accountId);
  }

  async firstPage(ctx: BrowserContext): Promise<Page> {
    const pages = ctx.pages();
    if (pages.length > 0) return pages[0]!;
    return ctx.newPage();
  }

  async close(accountId: number): Promise<void> {
    const ctx = this.contexts.get(accountId);
    if (!ctx) return;
    try {
      await ctx.close();
    } catch (err) {
      this.logger.warn(`error closing context ${accountId}: ${String(err)}`);
    }
    this.contexts.delete(accountId);
  }

  async onModuleDestroy(): Promise<void> {
    for (const [id, ctx] of this.contexts.entries()) {
      try {
        await ctx.close();
      } catch (err) {
        this.logger.warn(`shutdown: error closing context ${id}: ${String(err)}`);
      }
    }
    this.contexts.clear();
  }
}
