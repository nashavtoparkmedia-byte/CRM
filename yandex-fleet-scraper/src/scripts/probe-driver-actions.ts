/**
 * Reconnaissance script for the new driver-actions feature.
 *
 * Opens fleet.yandex.ru for a given driver + order, dumps:
 *   - Screenshot of the driver map card (with the dynamic price)
 *   - Screenshot of the order page (with Завершить/Отменить buttons)
 *   - List of DOM elements containing "₽" (price candidates)
 *   - List of action buttons (Завершить / Отменить / Сохранить / ...)
 *   - Full HTML of the order page for offline analysis
 *
 * Read-only. Does NOT click anything. Safe to run on a live order.
 *
 * Usage:
 *   PROBE_DRIVER_ID=2d26316bfedd4b2abe195148153a112e PROBE_ORDER_ID=02304798ca1aca4a83e22cec05261f6b npm run probe:driver-actions
 *
 * Defaults to Жемухов Мурат's driver+order from the latest session (may be stale).
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-driver-actions');

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

    console.log('🚀 Probe starting…');
    console.log(`   PARK_ID    = ${PARK_ID}`);
    console.log(`   DRIVER_ID  = ${DRIVER_ID}`);
    console.log(`   ORDER_ID   = ${ORDER_ID}`);
    console.log(`   PROFILE    = ${BOT_PROFILE_DIR}`);
    console.log(`   ARTIFACTS  = ${ARTIFACTS_DIR}`);
    console.log('');

    const context = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
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

    const page = context.pages()[0] ?? await context.newPage();
    if (!page) throw new Error('Could not get browser page');

    // ── STEP 1: Driver map card ──
    const driverUrl = `https://fleet.yandex.ru/map/drivers/${DRIVER_ID}?park_id=${PARK_ID}`;
    console.log(`\n── STEP 1: driver page ──\nnavigate -> ${driverUrl}`);
    try {
        await page.goto(driverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e: any) {
        console.warn(`⚠️ goto failed: ${e.message}`);
    }
    await page.waitForTimeout(4000);

    if (page.url().includes('passport.yandex.ru') || page.url().includes('/login')) {
        console.error('❌ Session expired — page redirected to passport.yandex.ru');
        console.error('   Run `npm run login` first, log in manually, then re-run probe.');
        await snap(page, '00_login_redirect');
        await context.close();
        process.exit(2);
    }

    await snap(page, '01_driver_full');
    const priceCandidates = await dumpPriceCandidates(page);
    await fs.writeFile(path.join(ARTIFACTS_DIR, '01_driver_price_candidates.json'), JSON.stringify(priceCandidates, null, 2), 'utf8');
    console.log(`💰 found ${priceCandidates.length} element(s) with ₽:`);
    for (const p of priceCandidates.slice(0, 20)) {
        console.log(`   - <${p.tag}> "${p.text}"  ${p.testid ? `[data-testid=${p.testid}]` : ''}`);
    }

    // ── STEP 2: Order page (Завершить/Отменить) ──
    const orderUrl = `https://fleet.yandex.ru/orders/${ORDER_ID}?park_id=${PARK_ID}`;
    console.log(`\n── STEP 2: order page ──\nnavigate -> ${orderUrl}`);
    try {
        await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e: any) {
        console.warn(`⚠️ goto failed: ${e.message}`);
    }
    await page.waitForTimeout(4000);

    await snap(page, '02_order_full');
    const actionButtons = await dumpActionButtons(page);
    await fs.writeFile(path.join(ARTIFACTS_DIR, '02_order_buttons.json'), JSON.stringify(actionButtons, null, 2), 'utf8');
    console.log(`🔘 found ${actionButtons.length} action button(s):`);
    for (const b of actionButtons) {
        console.log(`   - <${b.tag}> "${b.text}" ${b.disabled ? '(disabled)' : ''} ${b.testid ? `[data-testid=${b.testid}]` : ''}`);
    }

    // Save full HTML for offline grep
    const html = await page.content();
    await fs.writeFile(path.join(ARTIFACTS_DIR, '02_order.html'), html, 'utf8');
    console.log(`📄 saved 02_order.html (${(html.length / 1024).toFixed(1)} KB)`);

    // ── STEP 3: Hover/inspect Отменить without clicking (just to see if hover reveals tooltip) ──
    // We do NOT click anything. The cancel dialog will be reverse-engineered by reading the order page's modal markup
    // only if it's already rendered. If not — we'll open it manually in a follow-up probe run on a TEST order.

    console.log('\n✅ Probe complete. Artifacts in:', ARTIFACTS_DIR);
    console.log('   Closing browser…');
    await context.close();
}

main().catch((e) => {
    console.error('💥 Probe failed:', e);
    process.exit(1);
});
