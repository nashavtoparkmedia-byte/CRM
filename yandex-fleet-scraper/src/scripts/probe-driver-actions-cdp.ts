/**
 * Same as probe-driver-actions.ts, but connects to a USER-RUN Chrome via CDP
 * (Chrome DevTools Protocol). The user runs their normal Chrome with
 *     chrome.exe --remote-debugging-port=9222 --profile-directory="Profile 20"
 * and we attach to it. We reuse the user's already-authenticated Yandex
 * session — no need to log in inside playwright's own profile.
 *
 * We never close the user's Chrome. We open one tab, take artifacts,
 * close that tab.
 *
 * Usage:
 *   PROBE_DRIVER_ID=... PROBE_ORDER_ID=... npm run probe:driver-actions-cdp
 *
 * Defaults to Жемухов Мурат's driver+order from the latest session (may be stale).
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';

const CDP_URL = process.env.PROBE_CDP_URL || 'http://localhost:9222';
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-driver-actions-cdp');

const PARK_ID = process.env.PROBE_PARK_ID || '3a23295d8d714c03b61a17a6fc86601b';
const DRIVER_ID = process.env.PROBE_DRIVER_ID || '2d26316bfedd4b2abe195148153a112e';
const ORDER_ID = process.env.PROBE_ORDER_ID || '02304798ca1aca4a83e22cec05261f6b';

async function snap(page: import('playwright').Page, name: string) {
    const file = path.join(ARTIFACTS_DIR, `${name}.png`);
    try {
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 saved ${file}`);
    } catch (e: any) {
        console.warn(`⚠️ screenshot ${name} failed: ${e.message}`);
    }
}

async function dumpPriceCandidates(page: import('playwright').Page) {
    return await page.evaluate(() => {
        const result: Array<{ tag: string; text: string; classes: string; testid?: string }> = [];
        const all = document.querySelectorAll<HTMLElement>('*');
        all.forEach((el) => {
            const text = (el.textContent || '').trim();
            if (
                text.length > 0 &&
                text.length < 200 &&
                /\d/.test(text) &&
                /₽/.test(text) &&
                el.children.length <= 2
            ) {
                result.push({
                    tag: el.tagName,
                    text: text.slice(0, 120),
                    classes: (el.className || '').toString().slice(0, 180),
                    testid: el.getAttribute('data-testid') || undefined,
                });
            }
        });
        return result;
    });
}

async function dumpActionButtons(page: import('playwright').Page) {
    return await page.evaluate(() => {
        const result: Array<{ tag: string; text: string; classes: string; testid?: string; disabled?: boolean }> = [];
        const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"], a');
        buttons.forEach((el) => {
            const text = (el.textContent || '').trim();
            if (/^(Завершить|Отменить|Сохранить|Подтвердить|Отмена|Да|Нет)$/i.test(text)) {
                result.push({
                    tag: el.tagName,
                    text: text.slice(0, 80),
                    classes: (el.className || '').toString().slice(0, 180),
                    testid: el.getAttribute('data-testid') || undefined,
                    disabled: (el as HTMLButtonElement).disabled || undefined,
                });
            }
        });
        return result;
    });
}

async function main() {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

    console.log('🚀 Probe (CDP) starting…');
    console.log(`   CDP        = ${CDP_URL}`);
    console.log(`   PARK_ID    = ${PARK_ID}`);
    console.log(`   DRIVER_ID  = ${DRIVER_ID}`);
    console.log(`   ORDER_ID   = ${ORDER_ID}`);
    console.log(`   ARTIFACTS  = ${ARTIFACTS_DIR}`);
    console.log('');

    let browser: import('playwright').Browser;
    try {
        browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e: any) {
        console.error(`❌ Could not connect to Chrome at ${CDP_URL}: ${e.message}`);
        console.error('   Make sure Chrome is started with --remote-debugging-port=9222');
        process.exit(2);
    }

    const contexts = browser.contexts();
    if (contexts.length === 0) {
        console.error('❌ No browser contexts found via CDP. Open at least one tab.');
        process.exit(3);
    }
    const context = contexts[0];
    console.log(`✅ Connected. Existing pages in context: ${context.pages().length}`);

    const page = await context.newPage();

    // ── STEP 1: Driver map card ──
    const driverUrl = `https://fleet.yandex.ru/map/drivers/${DRIVER_ID}?park_id=${PARK_ID}`;
    console.log(`\n── STEP 1: driver page ──\nnavigate -> ${driverUrl}`);
    try {
        await page.goto(driverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e: any) {
        console.warn(`⚠️ goto failed: ${e.message}`);
    }
    await page.waitForTimeout(5000);

    if (page.url().includes('passport.yandex.ru') || page.url().includes('/login')) {
        console.error('❌ Page redirected to passport.yandex.ru — your Chrome session is not logged in to Yandex.');
        await snap(page, '00_login_redirect');
        await page.close();
        process.exit(2);
    }

    await snap(page, '01_driver_full');
    const priceCandidates = await dumpPriceCandidates(page);
    await fs.writeFile(path.join(ARTIFACTS_DIR, '01_driver_price_candidates.json'), JSON.stringify(priceCandidates, null, 2), 'utf8');
    console.log(`💰 found ${priceCandidates.length} element(s) with ₽:`);
    for (const p of priceCandidates.slice(0, 20)) {
        console.log(`   - <${p.tag}> "${p.text}"  ${p.testid ? `[data-testid=${p.testid}]` : ''}`);
    }

    // ── STEP 2: Order page ──
    const orderUrl = `https://fleet.yandex.ru/orders/${ORDER_ID}?park_id=${PARK_ID}`;
    console.log(`\n── STEP 2: order page ──\nnavigate -> ${orderUrl}`);
    try {
        await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e: any) {
        console.warn(`⚠️ goto failed: ${e.message}`);
    }
    await page.waitForTimeout(5000);

    await snap(page, '02_order_full');
    const actionButtons = await dumpActionButtons(page);
    await fs.writeFile(path.join(ARTIFACTS_DIR, '02_order_buttons.json'), JSON.stringify(actionButtons, null, 2), 'utf8');
    console.log(`🔘 found ${actionButtons.length} action button(s):`);
    for (const b of actionButtons) {
        console.log(`   - <${b.tag}> "${b.text}" ${b.disabled ? '(disabled)' : ''} ${b.testid ? `[data-testid=${b.testid}]` : ''}`);
    }

    const html = await page.content();
    await fs.writeFile(path.join(ARTIFACTS_DIR, '02_order.html'), html, 'utf8');
    console.log(`📄 saved 02_order.html (${(html.length / 1024).toFixed(1)} KB)`);

    console.log('\n✅ Probe complete. Artifacts in:', ARTIFACTS_DIR);
    console.log('   Closing the probe tab (your other tabs stay open)…');
    await page.close();
    // NOTE: we do NOT call browser.close() — that would close the user's Chrome.
    // CDP connection is just dropped when the script exits.
}

main().catch((e) => {
    console.error('💥 Probe failed:', e);
    process.exit(1);
});
