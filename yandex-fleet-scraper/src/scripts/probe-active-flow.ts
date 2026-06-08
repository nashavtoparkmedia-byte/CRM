/**
 * End-to-end UI reconnaissance for the driver-actions feature.
 *
 *   /contractors?segment=active&statuses=on_order  (find an active driver)
 *      ↓ click first driver
 *   /map/drivers/<driver_id>  or  /contractors/<driver_id>
 *      ↓ dump price card selectors
 *      ↓ click "Перейти к заказу"
 *   /orders/<order_id>
 *      ↓ dump Завершить / Отменить button selectors
 *      ↓ (don't click — read-only)
 *
 * Designed for the new fleet.yandex.ru dispatcher UI. Uses .bot_profile/.
 *
 *   PROBE_PARK_ID=45e30e9d6b824c608e5d28719cb19a6e npm run probe:active-flow
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-active-flow');
const PARK_ID = process.env.PROBE_PARK_ID || '45e30e9d6b824c608e5d28719cb19a6e';

async function snap(page: import('playwright').Page, name: string) {
    const file = path.join(ARTIFACTS_DIR, `${name}.png`);
    try {
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 ${name}`);
    } catch (e: any) { console.warn(`⚠️ screenshot ${name} failed: ${e.message}`); }
}

async function dumpHtml(page: import('playwright').Page, name: string) {
    const html = await page.content();
    await fs.writeFile(path.join(ARTIFACTS_DIR, `${name}.html`), html, 'utf8');
    console.log(`📄 ${name}.html (${(html.length / 1024).toFixed(1)} KB)`);
}

async function dumpInteractive(page: import('playwright').Page, name: string) {
    // Catalog every clickable / form / link element with visible text.
    const items = await page.evaluate(() => {
        const out: Array<any> = [];
        const sel = 'button, [role="button"], a, [data-testid]';
        document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
            const text = (el.textContent || '').trim();
            if (!text) return;
            if (text.length > 200) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            out.push({
                tag: el.tagName,
                role: el.getAttribute('role') || undefined,
                text: text.slice(0, 120),
                href: (el as HTMLAnchorElement).href || undefined,
                testid: el.getAttribute('data-testid') || undefined,
                classes: (el.className || '').toString().slice(0, 100),
            });
        });
        return out;
    });
    await fs.writeFile(path.join(ARTIFACTS_DIR, `${name}_interactive.json`), JSON.stringify(items, null, 2), 'utf8');
    console.log(`🔘 ${name}: ${items.length} interactive elements`);
}

async function dumpPriceCandidates(page: import('playwright').Page, name: string) {
    const items = await page.evaluate(() => {
        const out: Array<any> = [];
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
            const text = (el.textContent || '').trim();
            if (text.length > 0 && text.length < 200 && /\d/.test(text) && /₽/.test(text) && el.children.length <= 2) {
                out.push({
                    tag: el.tagName,
                    text: text.slice(0, 120),
                    classes: (el.className || '').toString().slice(0, 100),
                    testid: el.getAttribute('data-testid') || undefined,
                });
            }
        });
        return out;
    });
    await fs.writeFile(path.join(ARTIFACTS_DIR, `${name}_prices.json`), JSON.stringify(items, null, 2), 'utf8');
    console.log(`💰 ${name}: ${items.length} elements with ₽`);
    for (const p of items.slice(0, 10)) console.log(`   - "${p.text}"`);
    return items;
}

async function main() {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    console.log(`🚀 active-flow probe`);
    console.log(`   PARK_ID    : ${PARK_ID}`);
    console.log(`   PROFILE    : ${BOT_PROFILE_DIR}`);
    console.log(`   ARTIFACTS  : ${ARTIFACTS_DIR}\n`);

    const ctx = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized', '--lang=ru-RU'],
        locale: 'ru-RU',
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
    });
    await ctx.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
    const page = ctx.pages()[0] ?? await ctx.newPage();

    // ── STEP 1: open the active "on_order" list ──
    const listUrl = `https://fleet.yandex.ru/contractors?segment=active&statuses=on_order&park_id=${PARK_ID}`;
    console.log(`── STEP 1: list of "На заказе" drivers ──`);
    console.log(`navigate -> ${listUrl}`);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(7000); // SPA + auth + data fetch
    await snap(page, '01a_contractors_list_with_modals');

    // Dismiss the two onboarding overlays that block driver rows.
    // The new-menu overlay has buttons "Вернуться позже" + "Посмотреть изменения".
    // The analytics overlay has buttons "Позже" + "Подробнее".
    const dismissBtns = ['Вернуться позже', 'Позже'];
    for (const label of dismissBtns) {
        try {
            const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
            if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await btn.click({ timeout: 2000 });
                console.log(`✖ dismissed overlay "${label}"`);
                await page.waitForTimeout(1000);
            }
        } catch { /* fine */ }
    }
    await snap(page, '01_contractors_list');

    if (page.url().includes('passport.yandex.ru') || page.url().includes('/login')) {
        console.error('❌ redirected to passport — session expired'); await ctx.close(); process.exit(2);
    }
    const body = (await page.textContent('body')) || '';
    if (/Парки не найдены/i.test(body)) {
        console.error(`❌ "Парки не найдены" — nashavtopark has NO access to park ${PARK_ID}`);
        await snap(page, '01_no_park_access');
        await ctx.close(); process.exit(3);
    }

    await dumpHtml(page, '01_contractors_list');
    await dumpInteractive(page, '01_contractors_list');

    // Try to find clickable driver rows (they should be <tr> or <div> with a name + "На заказе" label)
    const driverLinks = await page.evaluate(() => {
        const out: Array<{ name: string; href?: string; outerHTMLSnippet: string }> = [];
        document.querySelectorAll<HTMLElement>('a, [role="link"], [data-testid*="driver" i], [class*="driver" i]').forEach((el) => {
            const text = (el.textContent || '').trim();
            if (text.length > 5 && text.length < 200 && /[А-Я][а-я]+ [А-Я][а-я]+/.test(text)) {
                out.push({
                    name: text.slice(0, 100),
                    href: (el as HTMLAnchorElement).href || undefined,
                    outerHTMLSnippet: el.outerHTML.slice(0, 200),
                });
            }
        });
        return out;
    });
    await fs.writeFile(path.join(ARTIFACTS_DIR, '01_driver_candidates.json'), JSON.stringify(driverLinks, null, 2), 'utf8');
    console.log(`👤 ${driverLinks.length} potential driver row(s)`);

    // ── STEP 2: click first driver row ──
    console.log(`\n── STEP 2: open first driver ──`);
    let driverClicked = false;
    // EXCLUDE the "+ Добавить водителя" header button — it also points to /contractors/...
    // We only want rows that mention "На заказе" (active status).
    const driverSelectors: Array<import('playwright').Locator> = [
        // Direct table row containing "На заказе"
        page.locator('tr:has-text("На заказе")').first(),
        page.locator('[class*="row" i]:has-text("На заказе")').first(),
        // Link to a specific driver profile (NOT /create/)
        page.locator('a[href*="/contractors/"]:not([href*="/create"]):not([href*="/admin"])').first(),
        // Generic: any clickable element with "На заказе" badge
        page.locator('[role="row"]:has-text("На заказе"), [role="link"]:has-text("На заказе")').first(),
    ];
    for (const loc of driverSelectors) {
        try {
            if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
                await loc.click({ timeout: 3000 });
                driverClicked = true;
                console.log(`✅ clicked driver row`);
                break;
            }
        } catch { /* try next */ }
    }
    if (!driverClicked) {
        console.warn('⚠️ could not click any driver row; dumping current page only');
    } else {
        await page.waitForTimeout(5000);
    }
    console.log(`current url: ${page.url()}`);
    await snap(page, '02_driver_card');
    await dumpHtml(page, '02_driver_card');
    await dumpInteractive(page, '02_driver_card');
    const priceCandidates = await dumpPriceCandidates(page, '02_driver');

    // ── STEP 3: try to open the linked order ──
    console.log(`\n── STEP 3: open the order ──`);
    let orderClicked = false;
    const orderSelectors: Array<import('playwright').Locator> = [
        page.getByRole('button', { name: /Перейти к заказу|К заказу/i }).first(),
        page.getByRole('link', { name: /Перейти к заказу|К заказу|Заказ/i }).first(),
        page.locator('a[href*="/orders/"]').first(),
        page.locator('button:has-text("Перейти к заказу")').first(),
    ];
    for (const loc of orderSelectors) {
        try {
            if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
                await loc.click({ timeout: 3000 });
                orderClicked = true;
                console.log(`✅ clicked "Перейти к заказу" candidate`);
                break;
            }
        } catch { /* try next */ }
    }
    if (orderClicked) {
        await page.waitForTimeout(5000);
        console.log(`current url: ${page.url()}`);
        await snap(page, '03_order_page');
        await dumpHtml(page, '03_order_page');
        await dumpInteractive(page, '03_order_page');
        await dumpPriceCandidates(page, '03_order');
    } else {
        console.warn('⚠️ no order link found from driver card');
    }

    console.log(`\n✅ probe done — artifacts: ${ARTIFACTS_DIR}`);
    console.log(`   Closing browser…`);
    await ctx.close();
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
