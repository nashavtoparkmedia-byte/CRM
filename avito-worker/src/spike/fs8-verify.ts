/// <reference lib="dom" />
/**
 * FS8 verification spike.
 *
 * Launches a throw-away Chromium context with the same init-script
 * shape used by BrowserRegistryService, navigates to about:blank,
 * and reads navigator.webdriver. Success criterion:
 *
 *   navigator.webdriver === undefined
 *
 * This does NOT touch any real account profile, so it's safe to run
 * in parallel with the worker.
 *
 * Usage:   pnpm --filter @avito/worker exec tsx src/spike/fs8-verify.ts
 */
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Must match BrowserRegistryService.WEBDRIVER_INIT_SCRIPT.
const WEBDRIVER_INIT_SCRIPT = `
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_e) {
    // no-op
  }
`;

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs8-verify-'));
  try {
    const ctx = await chromium.launchPersistentContext(tmp, {
      headless: true,
      viewport: { width: 800, height: 600 },
      channel: 'chrome',
    });
    await ctx.addInitScript(WEBDRIVER_INIT_SCRIPT);
    const page = await ctx.newPage();
    await page.goto('about:blank');

    const result = (await page.evaluate(
      '({ webdriver: navigator.webdriver, typeOf: typeof navigator.webdriver, ua: navigator.userAgent })',
    )) as { webdriver: unknown; typeOf: string; ua: string };

    // Keep output tight — one JSON line, exit code encodes pass/fail.
    const pass =
      result.webdriver === undefined && result.typeOf === 'undefined';

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        pass,
        webdriver: result.webdriver,
        typeOf: result.typeOf,
        userAgent: result.ua.slice(0, 80),
      }),
    );

    await ctx.close();
    process.exit(pass ? 0 : 1);
  } finally {
    // Best-effort cleanup of the temp profile.
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[fs8-verify] failed:', err);
  process.exit(2);
});
