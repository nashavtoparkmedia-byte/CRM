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
    port: parseInt(process.env.REDIS_PORT || '6379')
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
            headless: false,
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

// Start Worker
const worker = new Worker('check-history', processCheck, {
    connection: redisConnection,
    concurrency: 1
});

worker.on('completed', job => console.log(`✨ Job ${job.id} has completed!`));
worker.on('failed', (job, err) => console.error(`❌ Job ${job?.id} has failed with ${err.message}`));

console.log('👷 Worker started and listening to check-history queue...');
