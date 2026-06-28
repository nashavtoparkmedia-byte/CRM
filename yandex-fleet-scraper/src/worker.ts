import 'dotenv/config';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright-extra';
import type { Page, BrowserContext, Locator } from 'playwright';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parseDriverHistory } from './lib/parser.js';
import { Redis } from 'ioredis';
import fs from 'fs/promises';
import path from 'path';
import { expect } from '@playwright/test';

chromium.use(stealthPlugin());

const prisma = new PrismaClient();

const redisConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
};
const redis = new Redis(redisConnection);

const WATCHDOG_TIMEOUT_MS = 60000;
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts');

fs.mkdir(ARTIFACTS_DIR, { recursive: true }).catch(console.error);

async function saveErrorArtifacts(checkId: string, page: Page, errorMsg: string): Promise<string[]> {
    const paths: string[] = [];
    try {
        const timestamp = Date.now();
        const screenshotPath = path.join(ARTIFACTS_DIR, `${checkId}_${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        paths.push(screenshotPath);
    } catch (e) {
        console.error(`[Worker] Failed to save error screenshot for ${checkId}`, e);
    }
    return paths;
}

// ==========================================
// ARCHITECTURE: Helper Functions
// ==========================================

async function takeStepScreenshot(page: Page, checkId: string, step: string): Promise<void> {
    try {
        const p = path.join(ARTIFACTS_DIR, `${checkId}_${step}.png`);
        await page.screenshot({ path: p, fullPage: true });
        console.log(`[Worker][${checkId}] 📸 Screenshot: ${step}`);
    } catch (e) { /* non-fatal */ }
}

/**
 * Navigates to the scoring URL and validates the page loaded correctly.
 * Returns the stable search input locator.
 */
async function openScoringPage(page: Page, checkId: string, url: string): Promise<Locator> {
    console.log(`[Worker][${checkId}] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });

    console.log(`[Worker][${checkId}] Current URL after goto: ${page.url()}`);

    // Wait for SPA content to appear (Yandex Fleet is a React SPA with an initial spinner)
    await page.waitForSelector('input, h1, [class*="scoring"], [class*="search"]', { timeout: 20000 })
        .catch(() => { /* if nothing appears in 20s, take screenshot anyway */ });

    await takeStepScreenshot(page, checkId, '01_page_loaded');

    // Log ALL inputs on the page for diagnostics
    const allInputs = await page.locator('input').all();
    console.log(`[Worker][${checkId}] Found ${allInputs.length} input(s) on page:`);
    for (const inp of allInputs) {
        const ph = await inp.getAttribute('placeholder').catch(() => null);
        const type = await inp.getAttribute('type').catch(() => null);
        const name = await inp.getAttribute('name').catch(() => null);
        const cls = await inp.getAttribute('class').catch(() => null);
        const visible = await inp.isVisible().catch(() => false);
        console.log(`[Worker][${checkId}]   input: placeholder="${ph}" type="${type}" name="${name}" class="${cls?.slice(0, 50)}" visible=${visible}`);
    }

    // Try multiple strategies to find the license search input
    const strategies: Array<{ name: string; locator: Locator }> = [
        { name: 'getByPlaceholder regex', locator: page.getByPlaceholder(/Номер В\/У|В\/У|Driver.s license/i) },
        { name: 'getByPlaceholder exact', locator: page.getByPlaceholder('Номер В/У') },
        { name: 'input[placeholder*="В/У"]', locator: page.locator('input[placeholder*="В/У"]') },
        { name: 'input[placeholder*="В\\/У"]', locator: page.locator('input[placeholder*="В\\/У"]') },
        { name: 'input near Найти button', locator: page.locator('input').filter({ has: page.locator('..').filter({ hasText: 'Найти' }) }) },
        { name: 'first visible text input', locator: page.locator('input[type="text"]:visible, input:not([type]):visible').first() },
    ];

    for (const { name, locator } of strategies) {
        try {
            if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`[Worker][${checkId}] ✅ Input found via strategy: "${name}"`);
                return locator;
            }
        } catch { /* try next */ }
    }

    // Last resort: just grab the first visible input
    const fallback = page.locator('input:visible').first();
    if (await fallback.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`[Worker][${checkId}] ✅ Input found via fallback (first visible input)`);
        return fallback;
    }

    throw new Error('SEARCH_INPUT_NOT_FOUND: no input element found after all strategies');
}


/**
 * Clears the field, fills the license number, and verifies the value actually landed.
 */
async function fillLicenseInput(page: Page, checkId: string, input: ReturnType<Page['getByPlaceholder']>, license: string): Promise<void> {
    await input.click();
    await input.clear();
    await input.fill(license);

    const actual = await input.inputValue();
    if (actual !== license) {
        throw new Error(`INPUT_FILL_MISMATCH: expected "${license}", got "${actual}"`);
    }
    console.log(`[Worker][${checkId}] ✅ Input filled: "${actual}"`);
    await takeStepScreenshot(page, checkId, '02_input_filled');
}

/**
 * Triggers the search using Enter or the semantic "Найти" button.
 * Logs which method was used.
 */
async function triggerSearch(page: Page, checkId: string, input: ReturnType<Page['getByPlaceholder']>): Promise<void> {
    // Primary: Enter key
    await input.press('Enter');

    // Wait briefly to see if search initiated
    await page.waitForTimeout(800);

    // Fallback: semantic button if the page still shows the initial placeholder-only state
    const searchBtn = page.getByRole('button', { name: /Найти|Search/i });
    const btnVisible = await searchBtn.isVisible().catch(() => false);

    if (btnVisible) {
        const currentText = await input.inputValue().catch(() => '');
        if (currentText === '') {
            // Input was cleared — Enter worked and navigated away, button is stale
            console.log(`[Worker][${checkId}] 🔍 Search triggered via: Enter (input cleared after)`);
        } else {
            // Enter may not have triggered — try button
            console.log(`[Worker][${checkId}] ⚠️ Enter key may not have triggered search, trying button...`);
            await searchBtn.click();
            console.log(`[Worker][${checkId}] 🔍 Search triggered via: button click`);
        }
    } else {
        console.log(`[Worker][${checkId}] 🔍 Search triggered via: Enter`);
    }

    await takeStepScreenshot(page, checkId, '03_search_triggered');
}

/**
 * Waits for one of the expected result states after search.
 * Returns 'found' | 'not_found'.
 */
async function waitForSearchResult(page: Page, checkId: string): Promise<{ outcome: 'found' | 'not_found' }> {
    // Spinner / loading guard
    try {
        const loader = page.locator('.spin2, .loader, [data-testid="spin"]');
        if (await loader.count() > 0) {
            await loader.first().waitFor({ state: 'hidden', timeout: 15000 });
        }
    } catch { /* non-fatal */ }

    // Wait for network to settle after search
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

    const html = await page.content();
    await takeStepScreenshot(page, checkId, '04_result');

    // Detect "not found" state
    const notFoundTexts = ['не найден', 'Не найден', 'не найдено', 'Не найдено', 'not found', 'No results'];
    const isNotFound = notFoundTexts.some(t => html.includes(t));

    // Detect successful result: quota counter must appear (parser key signal)
    const hasQuota = html.includes('осталось');
    const hasResult = html.includes('Проверить') || html.includes('В/У') || hasQuota;

    if (!hasResult && !isNotFound) {
        // Search may not have run at all
        throw new Error('SEARCH_DID_NOT_EXECUTE: result area did not appear after search trigger');
    }

    const outcome = isNotFound ? 'not_found' : 'found';
    console.log(`[Worker][${checkId}] 🎯 Search result state: ${outcome} (quota visible: ${hasQuota})`);
    return { outcome };
}

export async function processCheck(job: Job) {
    const { checkId, crmDriverId: jobCrmDriverId } = job.data;
    console.log(`[Worker][${checkId}] Processing check (Attempt ${job.attemptsMade + 1}, crmDriverId: ${jobCrmDriverId || 'N/A'})`);

    await prisma.check.update({ where: { id: checkId }, data: { status: 'RUNNING', startedAt: new Date() } });

    const check = await prisma.check.findUnique({ where: { id: checkId }, include: { account: true } });
    if (!check || !check.account) {
        await failCheck(checkId, `Check or Account not found`);
        throw new UnrecoverableError(`Check or Account not found`);
    }

    // ── Business validation ───────────────────────────────────────────────────
    const license = check.license?.trim();
    if (!license) {
        const msg = 'BUSINESS_VALIDATION: license number is empty or missing in payload';
        await failCheck(checkId, msg);
        throw new UnrecoverableError(msg);
    }
    console.log(`[Worker][${checkId}] License from payload: "${license}"`);
    // ─────────────────────────────────────────────────────────────────────────

    const account = check.account;
    if (account.state !== 'ACTIVE') {
        const msg = `Account is in state ${account.state}`;
        await failCheck(checkId, msg);
        throw new UnrecoverableError(msg);
    }

    if (account.lastKnownChecksLeft !== null && account.lastKnownChecksLeft <= 1) {
        const msg = `QUOTA_EXCEEDED: Account has ${account.lastKnownChecksLeft} checks left`;
        await failCheck(checkId, msg);
        throw new UnrecoverableError(msg);
    }

    const lockKey = `lock:account:${account.id}`;
    const token = Date.now().toString();
    const acquired = await redis.set(lockKey, token, 'PX', 90000, 'NX');

    if (!acquired) {
        throw new Error(`Account ${account.id} is currently locked by another worker. Retrying...`);
    }

    let context: BrowserContext | null = null;
    let watchdogTimer: NodeJS.Timeout;

    const WATCHDOG_TIMEOUT_MS = 60000;

    const watchdogPromise = new Promise((_, reject) => {
        watchdogTimer = setTimeout(() => {
            reject(new Error('WATCHDOG_TIMEOUT: Playwright process hung or took too long'));
        }, WATCHDOG_TIMEOUT_MS);
    });

    try {
        const localUserDataDir = path.join(process.cwd(), '.bot_profile');
        console.log(`[Worker][${checkId}] Launching browser with persistent profile: ${localUserDataDir}`);

        context = await chromium.launchPersistentContext(localUserDataDir, {
            headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-position=0,0',
                '--start-maximized',
                '--ignore-certificate-errors',
                '--lang=ru-RU',
            ],
            locale: 'ru-RU',
            viewport: null,
            ignoreDefaultArgs: ['--enable-automation'],
        });

        await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

        const page: Page = context.pages()[0] || await context.newPage();

        const executionPromise = (async () => {
            const p = page as Page; // TS workaround since page is captured in closure
            const directTargetUrl = 'https://fleet.yandex.ru/contractors/scoring?park_id=3a23295d8d714c03b61a17a6fc86601b';

            // ── STEP 1: Navigate & wait for search input ────────────────────────────
            const searchInput = await openScoringPage(p, checkId, directTargetUrl);

            // ── Auth check ──────────────────────────────────────────────────────────
            if (p.url().includes('passport.yandex.ru') || p.url().includes('/login')) {
                console.log(`[Worker][${checkId}] ⚠️ Session expired — redirected to login`);
                await prisma.account.update({ where: { id: account.id }, data: { state: 'NEED_REAUTH' } });
                await takeStepScreenshot(p, checkId, 'err_reauth');
                await failCheck(checkId, 'NEED_REAUTH', [], (check as any).metadata);
                throw new UnrecoverableError('NEED_REAUTH');
            }

            // ── STEP 2: Fill license input ──────────────────────────────────────────
            await fillLicenseInput(p, checkId, searchInput, license);

            // ── STEP 3: Trigger search ──────────────────────────────────────────────
            await triggerSearch(p, checkId, searchInput);

            // ── CAPTCHA guard ───────────────────────────────────────────────────────
            const isCaptcha = await p
                .locator('iframe[src*="captcha"], .CheckboxCaptcha, :has-text("Подтвердите, что вы не робот")')
                .count() > 0;
            if (isCaptcha) {
                console.log(`[Worker][${checkId}] ⚠️ CAPTCHA detected`);
                await prisma.account.update({ where: { id: account.id }, data: { state: 'CAPTCHA' } });
                const artifactPaths = await saveErrorArtifacts(checkId, p, 'CAPTCHA detected');
                await failCheck(checkId, 'CAPTCHA detected', artifactPaths, (check as any).metadata);
                throw new UnrecoverableError('CAPTCHA detected');
            }

            // ── STEP 4: Wait for result & validate ─────────────────────────────────
            const { outcome } = await waitForSearchResult(p, checkId);

            // ── STEP 5: Parse & persist ─────────────────────────────────────────────
            let checksLeft = account.lastKnownChecksLeft;
            let resultJson: any = { outcome, checksLeft, otherParks: [] };

            if (outcome === 'found') {
                // Click "Обновить отчёт" if visible
                const refreshBtn = p.getByText('Обновить отчёт');
                if (await refreshBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    console.log(`[Worker][${checkId}] 📥 Clicking "Обновить отчёт"...`);
                    try {
                        await refreshBtn.click({ timeout: 5000 });
                        await p.waitForSelector(':text("Данные устарели")', { state: 'hidden', timeout: 5000 }).catch(() => { });
                        await p.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
                        console.log(`[Worker][${checkId}] ✅ Report updated successfully`);
                    } catch (e) {
                        console.log(`[Worker][${checkId}] ⚠️ Error clicking report update or timeout waiting, parsing as is.`);
                    }
                }

                try {
                    const parsedData = await parseDriverHistory(p);
                    checksLeft = parsedData.checksLeft ?? checksLeft;

                    if (parsedData.checksLeft !== null) {
                        await prisma.account.update({
                            where: { id: account.id },
                            data: { lastKnownChecksLeft: parsedData.checksLeft }
                        });
                    }

                    // Store all extracted data
                    resultJson = { outcome, ...parsedData, checksLeft };
                } catch (parseError: any) {
                    console.log(`[Worker][${checkId}] Parse error: ${parseError.message}`);
                    const artifactPaths = await saveErrorArtifacts(checkId, p, parseError.message);
                    await failCheck(checkId, `PARSER_SCHEMA_CHANGED: ${parseError.message}`, artifactPaths);
                    throw new UnrecoverableError(`PARSER_SCHEMA_CHANGED: ${parseError.message}`);
                }
            }

            await prisma.$transaction([
                prisma.checkResult.create({
                    data: { checkId, resultJson: JSON.stringify(resultJson) }
                }),
                prisma.check.update({
                    where: { id: checkId },
                    data: { status: 'SUCCESS', finishedAt: new Date(), errorCode: null, errorMessage: null }
                }),
                prisma.account.update({
                    where: { id: account.id },
                    data: { lastSuccessAt: new Date(), failureStreak: 0, healthScore: 100 }
                })
            ]);

            console.log(`[Worker][${checkId}] ✅ Check complete — outcome: ${outcome}`);
            await fireWebhook(checkId, 'SUCCESS', resultJson, undefined, check.metadata, jobCrmDriverId);

        })();

        await Promise.race([executionPromise, watchdogPromise]);

    } catch (e: any) {
        console.error(`[Worker] ❌ Error on check ${checkId}: ${e.message}`);

        // Final fallback screenshot for diagnostics
        if (context) {
            try {
                const pages = context.pages();
                if (pages.length > 0) {
                    await saveErrorArtifacts(checkId, pages[0], `Error_Trace_${e.message}`);
                }
            } catch (ignore) { }
        }

        if (!(e instanceof UnrecoverableError)) {
            await failCheck(checkId, e.message, [], (check as any).metadata, jobCrmDriverId);
            await prisma.account.update({
                where: { id: account.id },
                data: {
                    lastFailureAt: new Date(),
                    failureStreak: { increment: 1 },
                    healthScore: Math.max(0, account.healthScore - 10)
                }
            });
            throw e;
        }

    } finally {
        clearTimeout(watchdogTimer!);

        // Gracefully kill the chromium persistent profile so next background worker can lock it
        if (context) await context.close().catch(() => { });

        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        await redis.eval(script, 1, lockKey, token);
    }
}

async function fireWebhook(checkId: string, status: 'SUCCESS' | 'FAILED', resultJson?: any, errorCode?: string, metadataStr?: string | null, crmDriverId?: string | null) {
    const webhookUrl = process.env.CRM_WEBHOOK_URL;
    if (!webhookUrl) {
        console.log(`[Worker] ⚠️ CRM_WEBHOOK_URL not set — skipping webhook for ${checkId}`);
        return;
    }

    try {
        let metadata: any = null;
        if (metadataStr) {
            try { metadata = JSON.parse(metadataStr); } catch (e) { }
        }

        const driverId = crmDriverId || metadata?.crmDriverId || null;

        const body = {
            checkId,
            driverId,
            status,
            finishedAt: new Date().toISOString(),
            result: resultJson || null,
            errorCode: errorCode || null,
        };

        console.log(`[Worker] Firing webhook for ${checkId} → ${webhookUrl} (driverId: ${driverId}, status: ${status})`);

        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        console.log(`[Worker] Webhook response: ${res.status} ${res.statusText}`);
    } catch (e: any) {
        console.error(`[Worker] Failed to fire webhook for ${checkId}:`, e.message);
    }
}

async function failCheck(checkId: string, errorMsg: string, artifactPaths: string[] = [], metadataStr: string | null = null, crmDriverId?: string | null) {
    let errorCode = 'UNKNOWN_ERROR';
    if (errorMsg.includes('NEED_REAUTH')) errorCode = 'NEED_REAUTH';
    else if (errorMsg.includes('CAPTCHA')) errorCode = 'CAPTCHA';
    else if (errorMsg.includes('QUOTA_EXCEEDED')) errorCode = 'QUOTA_EXCEEDED';
    else if (errorMsg.includes('PARSER_SCHEMA_CHANGED')) errorCode = 'PARSER_SCHEMA_CHANGED';
    else if (errorMsg.includes('WATCHDOG')) errorCode = 'WATCHDOG_TIMEOUT';

    const updateData: any = {
        status: 'FAILED',
        finishedAt: new Date(),
        errorCode,
        errorMessage: errorMsg
    };

    if (artifactPaths.length > 0) {
        updateData.errorMessage = `${errorMsg} | Artifacts: ${artifactPaths.join(', ')}`;
    }

    await prisma.check.update({
        where: { id: checkId },
        data: updateData
    });

    await fireWebhook(checkId, 'FAILED', null, errorCode, metadataStr, crmDriverId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver-Actions processors (GET_PRICE / COMPLETE_ORDER / CANCEL_ORDER).
//
// All three reuse the same Chromium persistent profile (.bot_profile/) as
// the legacy check-history worker — only one job runs at a time (concurrency
// 1) because of the profile SingletonLock.
//
// Feature flags (yandex-fleet-scraper/.env):
//   PRICE_MOCK=true                   — GET_PRICE returns mock data (default)
//   COMPLETE_ORDER_LIVE_ENABLED=true  — COMPLETE_ORDER clicks "Завершить"
//   CANCEL_ORDER_LIVE_ENABLED=false   — CANCEL_ORDER stops before confirming
//                                       the cancel-reason modal (since the
//                                       modal selectors aren't reversed yet)
// ─────────────────────────────────────────────────────────────────────────────

const DRIVER_ACTION_TTL_SEC = 3600;
const driverActionKey = (taskId: string) => `driver-action:${taskId}`;

async function patchDriverActionState(taskId: string, patch: Record<string, any>) {
    const raw = await redis.get(driverActionKey(taskId));
    if (!raw) return;
    const state = JSON.parse(raw);
    Object.assign(state, patch, { completedAt: patch.status && patch.status !== 'PENDING' ? Date.now() : state.completedAt });
    await redis.set(driverActionKey(taskId), JSON.stringify(state), 'EX', DRIVER_ACTION_TTL_SEC);
}

function envFlag(name: string, fallback: boolean): boolean {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(v.trim());
}

async function dismissOverlays(page: Page): Promise<void> {
    const labels = ['Вернуться позже', 'Позже', 'Понятно', 'Пропустить'];
    for (const label of labels) {
        try {
            const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
            if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
                await btn.click({ timeout: 1500 });
                await page.waitForTimeout(500);
            }
        } catch { /* fine */ }
    }
    for (let pass = 0; pass < 4; pass++) {
        const closed = await page.evaluate(() => {
            const cs = Array.from(document.querySelectorAll<HTMLElement>(
                'button[aria-label*="закрыт" i], button[aria-label*="close" i], [data-testid*="close" i]'
            ));
            for (const el of cs) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { (el as HTMLElement).click(); return true; }
            }
            return false;
        });
        if (!closed) break;
        await page.waitForTimeout(300);
    }
}

interface DriverActionJob {
    kind: 'GET_PRICE' | 'COMPLETE_ORDER' | 'CANCEL_ORDER';
    taskId: string;
    driverYandexId: string;
    parkId: string;
    reason: string | null;
}

async function withDriverProfile<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const userDataDir = path.join(process.cwd(), '.bot_profile');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--start-maximized',
            '--lang=ru-RU',
        ],
        locale: 'ru-RU',
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
    });
    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

    // Import saved fleet.yandex.ru session cookies (uploaded via POST /api/fleet-cookies)
    const cookiesPath = process.env.FLEET_COOKIES_PATH || '/app/data/fleet_cookies.json';
    try {
        const { readFileSync, existsSync } = await import('fs');
        if (existsSync(cookiesPath)) {
            const { cookies } = JSON.parse(readFileSync(cookiesPath, 'utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) {
                await context.addCookies(cookies);
                console.log(`[withDriverProfile] loaded ${cookies.length} fleet cookies`);
            }
        }
    } catch (e: any) {
        console.warn(`[withDriverProfile] cookie load failed: ${e.message}`);
    }

    try {
        const page = context.pages()[0] ?? await context.newPage();
        return await fn(page);
    } finally {
        await context.close().catch(() => {});
    }
}

/**
 * Open the driver's "Заказы" tab (last 30 days) and return the active order
 * info — the topmost row that is NOT in "Выполнен" / "Отменён" state.
 */
/**
 * Step 1: locate the active order via /contractors/<driver>/orders.
 *
 * This is the proven approach — the orders tab table includes the order
 * code as a numeric <a href="/orders/<long_id>"> in the topmost non-terminal
 * row, giving us BOTH the long id (needed for Complete/Cancel) and the
 * direct URL for enrichment. Returns null when no active order.
 *
 * NOTE: the orders tab does NOT carry the live price. For that we make a
 * separate one-shot trip to /map/drivers/<id> in `getOrderPriceFromMap`.
 */
async function locateActiveOrder(page: Page, driverYandexId: string, parkId: string) {
    const periodFrom = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19) + 'Z';
    const periodTo   = new Date(Date.now() +  1 * 86400_000).toISOString().slice(0, 19) + 'Z';
    const url = `https://fleet.yandex.ru/contractors/${driverYandexId}/orders` +
        `?park_id=${parkId}` +
        `&metrics_period_start=${encodeURIComponent(periodFrom)}` +
        `&metrics_period_end=${encodeURIComponent(periodTo)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    if (page.url().includes('passport.yandex.ru') || page.url().includes('/login')) {
        throw new Error('NEED_REAUTH');
    }

    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300));
    if (/Войдите в аккаунт|Парки не найдены/i.test(bodyText)) {
        console.log(`[locateActiveOrder] Auth failure detected on fleet.yandex.ru: "${bodyText.slice(0, 100)}"`);
        throw new Error('NEED_REAUTH');
    }

    return await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('tr'));
        for (const row of rows) {
            const text = (row.textContent || '');
            if (/^\s*(Статус|Код заказа|Исполнитель)/i.test(text)) continue;
            if (/Выполнен|Отменён|Отменен/i.test(text)) continue;
            const links = Array.from(row.querySelectorAll<HTMLAnchorElement>('a'));
            let orderLink: HTMLAnchorElement | null = null;
            for (const a of links) {
                const t = (a.textContent || '').trim();
                if (/^\d{6,}$/.test(t)) { orderLink = a; break; }
            }
            if (!orderLink) continue;

            const shortOrderId = (orderLink.textContent || '').trim();
            const orderIdMatch = orderLink.href.match(/\/orders\/([a-f0-9]{24,})/);

            return {
                shortOrderId,
                orderHref: orderLink.href,
                orderLongId: orderIdMatch?.[1] || null,
                rowText: text.slice(0, 200),
            };
        }
        return null;
    });
}

/**
 * Lightweight scrape of /map/drivers/<id> — pulls the live "Фиксированная
 * стоимость" (only place Yandex shows the order price) and "Время поездки"
 * (cheaper to read here than to open another /orders/<long> tab).
 */
async function getOrderPriceFromMap(page: Page, driverYandexId: string, parkId: string): Promise<{ priceRub: number | null; durationText: string | null }> {
    const url = `https://fleet.yandex.ru/map/drivers/${driverYandexId}?park_id=${parkId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    await dismissOverlays(page);

    const evalScript = `(() => {
        var valueNextTo = function(labelExact) {
            var all = Array.prototype.slice.call(document.querySelectorAll('*'));
            var labelEls = all.filter(function(el) {
                var t = (el.textContent || '').trim();
                if (t !== labelExact) return false;
                return !Array.prototype.slice.call(el.children).some(function(c) {
                    return (c.textContent || '').trim() === labelExact;
                });
            });
            for (var i = 0; i < labelEls.length; i++) {
                var el = labelEls[i];
                var sib = el.nextElementSibling;
                while (sib) {
                    var t = (sib.textContent || '').trim();
                    if (t && t !== labelExact && t.length < 200) return t;
                    sib = sib.nextElementSibling;
                }
            }
            return null;
        };
        var priceStr = valueNextTo('Фиксированная стоимость');
        var priceRub = null;
        if (priceStr) {
            var m = priceStr.match(/([\\d\\s.,]+)/);
            if (m) {
                var n = parseFloat(m[1].replace(/\\s+/g, '').replace(',', '.'));
                if (!isNaN(n)) priceRub = n;
            }
        }
        return {
            priceRub: priceRub,
            durationText: valueNextTo('Время поездки')
        };
    })()`;
    return await page.evaluate(evalScript) as any;
}

/**
 * Step 2: enrich with fields from the order page (/orders/<long_id>).
 *
 * The order page is what gives stable, fully-qualified data:
 *   - Дата подачи заказа  → e.g. "9 июня в 00:03"
 *   - Чей заказ           → e.g. "Яндекс Такси"
 *   - Тариф               → e.g. "Эконом"
 *   - Оплата              → e.g. "Безналичные"
 *   - Откуда / Куда       → the addresses with trailing "· Откуда" / "· Куда"
 *                            (we pick the *shortest* match so we land on the
 *                            individual <li> with the FINAL Куда, not a parent
 *                            <ul> that concatenates intermediate stops)
 */
async function enrichOrderFromPage(page: Page, orderHref: string, parkId: string, orderLongId: string | null) {
    const url = orderHref || (orderLongId
        ? `https://fleet.yandex.ru/orders/${orderLongId}?park_id=${parkId}`
        : null);
    if (!url) return null;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    await dismissOverlays(page);

    const evalScript = `(() => {
        var valueNextTo = function(labelExact) {
            var all = Array.prototype.slice.call(document.querySelectorAll('*'));
            var labelEls = all.filter(function(el) {
                var t = (el.textContent || '').trim();
                if (t !== labelExact) return false;
                return !Array.prototype.slice.call(el.children).some(function(c) {
                    return (c.textContent || '').trim() === labelExact;
                });
            });
            for (var i = 0; i < labelEls.length; i++) {
                var el = labelEls[i];
                var sib = el.nextElementSibling;
                while (sib) {
                    var t = (sib.textContent || '').trim();
                    if (t && t !== labelExact && t.length < 200) return t;
                    sib = sib.nextElementSibling;
                }
                var p = el.parentElement;
                for (var j = 0; j < 5 && p; j++, p = p.parentElement) {
                    var kids = Array.prototype.slice.call(p.children);
                    for (var k = 0; k < kids.length; k++) {
                        var ch = kids[k];
                        if (ch.contains(el) || el.contains(ch)) continue;
                        var ct = (ch.textContent || '').trim();
                        if (ct && ct !== labelExact && ct.length < 200) return ct;
                    }
                    var pt = (p.textContent || '').trim();
                    if (pt.length > labelExact.length && pt.length < labelExact.length + 200) {
                        var idx = pt.indexOf(labelExact);
                        if (idx === 0) {
                            var rest = pt.slice(labelExact.length).trim();
                            if (rest) return rest.slice(0, 200);
                        } else if (idx > 0) {
                            var head = pt.slice(0, idx).trim();
                            var tail = pt.slice(idx + labelExact.length).trim();
                            var cand = tail || head;
                            if (cand) return cand.slice(0, 200);
                        }
                    }
                }
            }
            return null;
        };
        var addressByTrailingLabel = function(label) {
            var re = new RegExp('(.+?)\\\\s*[·•]\\\\s*' + label + '\\\\s*$');
            var all = Array.prototype.slice.call(document.querySelectorAll('li, div, p, span'));
            var best = null;
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var t = (el.textContent || '').trim();
                if (t.length < 5 || t.length > 250) continue;
                var m = t.match(re);
                if (m && m[1].trim().length >= 3) {
                    var v = m[1].trim();
                    v = v.split(/[·•]\\s*(?:Откуда|Куда|Остановка)\\s*\\d*\\s*/).pop().trim();
                    if (v.length >= 3 && (best === null || v.length < best.length)) {
                        best = v;
                    }
                }
            }
            return best ? best.slice(0, 200) : null;
        };
        // Intermediate stops — Yandex marks them as "· Остановка 1",
        // "· Остановка 2" etc. Pick the shortest match per stop number
        // (avoids parents that concatenate the whole list).
        var collectStops = function() {
            var re = /(.+?)\\s*[·•]\\s*Остановка\\s+(\\d+)\\s*$/;
            var all = Array.prototype.slice.call(document.querySelectorAll('li, div, p, span'));
            var bestByIdx = {};
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var t = (el.textContent || '').trim();
                if (t.length < 5 || t.length > 250) continue;
                var m = t.match(re);
                if (!m) continue;
                var addr = m[1].trim();
                var n = parseInt(m[2], 10);
                addr = addr.split(/[·•]\\s*(?:Откуда|Куда|Остановка)\\s*\\d*\\s*/).pop().trim();
                if (addr.length < 3) continue;
                if (!bestByIdx[n] || addr.length < bestByIdx[n].length) {
                    bestByIdx[n] = addr.slice(0, 200);
                }
            }
            var nums = Object.keys(bestByIdx).map(function(s){return parseInt(s, 10);}).sort(function(a,b){return a-b;});
            return nums.map(function(n){return bestByIdx[n];});
        };

        return {
            bookedAt:      valueNextTo('Дата подачи заказа'),
            orderSource:   valueNextTo('Чей заказ'),
            tariff:        valueNextTo('Тариф'),
            paymentMethod: valueNextTo('Оплата'),
            fromAddress:   addressByTrailingLabel('Откуда'),
            toAddress:     addressByTrailingLabel('Куда'),
            stops:         collectStops()
        };
    })()`;
    return await page.evaluate(evalScript) as any;
}

/**
 * Capture a screenshot of the full-screen route map for the given order.
 * Yandex's /orders/<long>/map page renders a viewport-wide map with the
 * pickup, drops, and current driver position. We return base64 PNG so the
 * bot can `replyWithPhoto({ source: buffer })` without a separate endpoint.
 */
async function captureOrderMapScreenshot(page: Page, orderLongId: string, parkId: string): Promise<{ base64: string | null; distanceText: string | null }> {
    const url = `https://fleet.yandex.ru/orders/${orderLongId}/map?park_id=${parkId}`;
    try {
        // Force a wide viewport so the map isn't cramped in headless Docker.
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // The map tiles + route line need extra time after DOM is ready.
        await page.waitForTimeout(5500);

        // Pull "Расстояние" from the right-side details panel before we crop it out.
        const distanceText = await page.evaluate(`(() => {
            var all = Array.prototype.slice.call(document.querySelectorAll('*'));
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var t = (el.textContent || '').trim();
                if (t !== 'Расстояние') continue;
                if (Array.prototype.slice.call(el.children).some(function(c){ return (c.textContent || '').trim() === 'Расстояние'; })) continue;
                var sib = el.nextElementSibling;
                while (sib) {
                    var st = (sib.textContent || '').trim();
                    if (st && st !== 'Расстояние' && st.length < 60) return st;
                    sib = sib.nextElementSibling;
                }
                var p = el.parentElement;
                for (var j = 0; j < 4 && p; j++, p = p.parentElement) {
                    var kids = Array.prototype.slice.call(p.children);
                    for (var k = 0; k < kids.length; k++) {
                        var ch = kids[k];
                        if (ch.contains(el) || el.contains(ch)) continue;
                        var ct = (ch.textContent || '').trim();
                        if (ct && ct !== 'Расстояние' && ct.length < 60) return ct;
                    }
                }
            }
            return null;
        })()`) as string | null;

        // Crop out the Yandex Fleet left nav rail and the right-side
        // "Заказ" details panel so the screenshot is map-only.
        // Defaults match observed UI; can be overridden via env.
        const leftPad = parseInt(process.env.MAP_LEFT_PAD || '80', 10);
        const rightPad = parseInt(process.env.MAP_RIGHT_PAD || '480', 10);
        const dims = await page.evaluate(() =>
            ({ w: window.innerWidth, h: window.innerHeight })
        );
        const clipW = Math.max(200, dims.w - leftPad - rightPad);
        const clipH = dims.h;
        const buf = await page.screenshot({
            type: 'jpeg',
            quality: 70,
            clip: { x: leftPad, y: 0, width: clipW, height: clipH },
        });
        return { base64: buf.toString('base64'), distanceText };
    } catch (e: any) {
        console.warn(`captureOrderMapScreenshot failed: ${e?.message || e}`);
        return { base64: null, distanceText: null };
    }
}

async function processGetPrice(job: DriverActionJob) {
    const { taskId, driverYandexId, parkId } = job;

    // Mock kept as an emergency escape hatch (PRICE_MOCK=true) — useful for
    // demos when scraper Chromium is broken. Default false: real flow.
    if (envFlag('PRICE_MOCK', false)) {
        await patchDriverActionState(taskId, {
            status: 'DONE',
            result: {
                mock: true, shortOrderId: '0000000', priceRub: 0, fixedPriceRub: 0,
                paymentMethod: 'неизвестно', fromAddress: 'мок', toAddress: 'мок', durationMin: null,
            },
        });
        return;
    }

    await withDriverProfile(async (page) => {
        // 1) Find active order via the proven /contractors/<id>/orders tab.
        const active = await locateActiveOrder(page, driverYandexId, parkId);
        if (!active) {
            await patchDriverActionState(taskId, {
                status: 'DONE',
                result: { noActiveOrder: true },
            });
            return;
        }
        // 2) Enrich from /orders/<long_id> — dates, source, tariff, payment, addresses.
        const enrich = await enrichOrderFromPage(page, active.orderHref, parkId, active.orderLongId);
        // 3) "Фиксированная стоимость" + "Время поездки" from /map/drivers/<id>.
        let priceRub: number | null = null;
        let durationText: string | null = null;
        try {
            const mp = await getOrderPriceFromMap(page, driverYandexId, parkId);
            priceRub = mp.priceRub;
            durationText = mp.durationText;
        } catch (e: any) {
            console.warn(`[Worker][${taskId}] price-from-map failed: ${e.message}`);
        }
        // 4) Full-screen route map screenshot + Расстояние.
        let mapImageBase64: string | null = null;
        let distanceText: string | null = null;
        if (active.orderLongId) {
            const cap = await captureOrderMapScreenshot(page, active.orderLongId, parkId);
            mapImageBase64 = cap.base64;
            distanceText = cap.distanceText;
        }
        console.log(`[Worker][${taskId}] short=${active.shortOrderId} priceRub=${priceRub} duration=${durationText} distance=${distanceText} mapImage=${mapImageBase64 ? mapImageBase64.length + ' chars b64' : 'null'} enrich=${JSON.stringify(enrich)}`);

        await patchDriverActionState(taskId, {
            status: 'DONE',
            result: {
                shortOrderId: active.shortOrderId,
                orderLongId: active.orderLongId,
                priceRub:      priceRub,
                bookedAt:      enrich?.bookedAt || null,
                orderSource:   enrich?.orderSource || null,
                tariff:        enrich?.tariff || null,
                paymentMethod: enrich?.paymentMethod || null,
                fromAddress:   enrich?.fromAddress || null,
                toAddress:     enrich?.toAddress || null,
                stops:         enrich?.stops || [],
                durationText,
                distanceText,
                mapImageBase64,
            },
        });
    });
}

async function processCompleteOrder(job: DriverActionJob) {
    const { taskId, driverYandexId, parkId } = job;
    const liveEnabled = envFlag('COMPLETE_ORDER_LIVE_ENABLED', false);

    await withDriverProfile(async (page) => {
        const active = await locateActiveOrder(page, driverYandexId, parkId);
        if (!active) {
            await patchDriverActionState(taskId, {
                status: 'DONE',
                result: { noActiveOrder: true },
            });
            return;
        }

        // Order exists. If live flag is off — escalate to manager but tell the
        // bot what order we found so the message can be specific.
        if (!liveEnabled) {
            await patchDriverActionState(taskId, {
                status: 'ESCALATED_TO_MANAGER',
                result: { shortOrderId: active.shortOrderId, orderLongId: active.orderLongId },
                errorMessage: 'COMPLETE_ORDER_LIVE_ENABLED=false — manager will close the order',
            });
            return;
        }

        await page.goto(active.orderHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
        await dismissOverlays(page);
        await takeStepScreenshot(page, taskId, 'complete_before');

        const completeBtn = page.getByRole('button', { name: /^Завершить$/i }).first();
        if (!await completeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await takeStepScreenshot(page, taskId, 'complete_no_button');
            await patchDriverActionState(taskId, {
                status: 'FAILED',
                errorMessage: 'Завершить button not visible',
            });
            return;
        }
        await completeBtn.click({ timeout: 3000 });
        await page.waitForTimeout(2500);
        await takeStepScreenshot(page, taskId, 'complete_after_click');

        // A confirmation modal may appear — try a generic confirm.
        try {
            const confirm = page.getByRole('button', { name: /Завершить заказ|Подтвердить|Да/i }).first();
            if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) {
                await confirm.click({ timeout: 2000 });
                await page.waitForTimeout(2000);
                await takeStepScreenshot(page, taskId, 'complete_after_confirm');
            }
        } catch { /* no modal — single-click flow */ }

        await patchDriverActionState(taskId, {
            status: 'DONE',
            result: {
                shortOrderId: active.shortOrderId,
                orderLongId: active.orderLongId,
                rowText: active.rowText.slice(0, 200),
            },
        });
    });
}

async function processCancelOrder(job: DriverActionJob) {
    const { taskId, driverYandexId, parkId, reason } = job;
    const liveEnabled = envFlag('CANCEL_ORDER_LIVE_ENABLED', false);

    // Optimistic flow: assume no reason-modal (or a trivial confirm). If a
    // live test reveals a dropdown of reasons, we'll extend this with the
    // selectors discovered in that probe.
    await withDriverProfile(async (page) => {
        const active = await locateActiveOrder(page, driverYandexId, parkId);
        if (!active) {
            await patchDriverActionState(taskId, {
                status: 'DONE',
                result: { noActiveOrder: true },
            });
            return;
        }

        if (!liveEnabled) {
            await patchDriverActionState(taskId, {
                status: 'ESCALATED_TO_MANAGER',
                result: { shortOrderId: active.shortOrderId, orderLongId: active.orderLongId },
                errorMessage: 'CANCEL_ORDER_LIVE_ENABLED=false — manager will cancel the order',
            });
            return;
        }

        await page.goto(active.orderHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
        await dismissOverlays(page);
        await takeStepScreenshot(page, taskId, 'cancel_before');

        const cancelBtn = page.getByRole('button', { name: /^Отменить$/i }).first();
        if (!await cancelBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await takeStepScreenshot(page, taskId, 'cancel_no_button');
            await patchDriverActionState(taskId, {
                status: 'FAILED',
                errorMessage: 'Отменить button not visible',
            });
            return;
        }
        await cancelBtn.click({ timeout: 3000 });
        await page.waitForTimeout(2500);
        await takeStepScreenshot(page, taskId, 'cancel_after_click');

        // Generic confirm modal — same shape as in processCompleteOrder.
        try {
            const confirm = page.getByRole('button', { name: /Отменить заказ|Подтвердить|Да/i }).first();
            if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) {
                await confirm.click({ timeout: 2000 });
                await page.waitForTimeout(2000);
                await takeStepScreenshot(page, taskId, 'cancel_after_confirm');
            }
        } catch { /* no modal — single-click flow */ }

        await patchDriverActionState(taskId, {
            status: 'DONE',
            result: {
                shortOrderId: active.shortOrderId,
                orderLongId: active.orderLongId,
                reason: reason || 'Отменено водителем',
                rowText: active.rowText.slice(0, 200),
            },
        });
    });
}

async function dispatchJob(job: Job) {
    const data: any = job.data || {};
    if (data.kind && ['GET_PRICE', 'COMPLETE_ORDER', 'CANCEL_ORDER'].includes(data.kind)) {
        try {
            if (data.kind === 'GET_PRICE') return await processGetPrice(data);
            if (data.kind === 'COMPLETE_ORDER') return await processCompleteOrder(data);
            if (data.kind === 'CANCEL_ORDER') return await processCancelOrder(data);
        } catch (e: any) {
            console.error(`[Worker][${data.taskId}] driver-action ${data.kind} failed:`, e.message);
            await patchDriverActionState(data.taskId, {
                status: /NEED_REAUTH/.test(e.message || '') ? 'FAILED' : 'FAILED',
                errorMessage: e.message || String(e),
            });
            throw e;
        }
        return;
    }
    // Legacy: CHECK_HISTORY-style payload (license, checkId, ...)
    return await processCheck(job);
}

// Start Worker
const worker = new Worker('check-history', dispatchJob, {
    connection: redisConnection,
    concurrency: 1
});

worker.on('completed', job => console.log(`✨ Job ${job.id} has completed!`));
worker.on('failed', (job, err) => console.error(`❌ Job ${job?.id} has failed with ${err.message}`));

console.log('👷 Worker started and listening to check-history queue (incl. driver-action jobs)...');
