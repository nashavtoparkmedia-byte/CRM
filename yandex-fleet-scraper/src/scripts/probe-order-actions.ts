/**
 * Reconnaissance for the order page actions (Завершить / Отменить) in the
 * NEW fleet.yandex.ru dispatcher UI, via the driver's "Заказы" tab.
 *
 * Path (per user, variant 2 — driver card → Заказы):
 *
 *   /contractors?segment=active&statuses=on_order  (list of "На заказе" drivers)
 *      ↓ pick first driver, extract their yandexDriverId from the row href
 *   /contractors/<id>/orders?park_id=<park>  (driver's orders tab)
 *      ↓ find row with active status ("Везёт клиента" / "На заказе")
 *      ↓ click the "Код заказа" link in that row
 *   /orders/<short>  or  /contractors/<id>/orders/<short>
 *      ↓ DUMP buttons "Завершить" / "Отменить" / "Отменить заказ" /
 *        "Завершить заказ" — DO NOT click them.
 *
 * SAFETY: this script never clicks the actual Завершить / Отменить buttons.
 * It only opens pages and scans the DOM. Cancel reason dropdown discovery
 * is deferred to a later, supervised run.
 *
 *   PROBE_PARK_ID=45e30e9d6b824c608e5d28719cb19a6e npm run probe:order-actions
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-order-actions');
const PARK_ID = process.env.PROBE_PARK_ID || '45e30e9d6b824c608e5d28719cb19a6e';
// If set, skip Step 1 (list) and go straight to this driver's orders tab.
const FORCED_DRIVER_ID = process.env.PROBE_DRIVER_ID || '';

async function snap(page: import('playwright').Page, name: string) {
    const file = path.join(ARTIFACTS_DIR, `${name}.png`);
    try { await page.screenshot({ path: file, fullPage: true }); console.log(`📸 ${name}`); }
    catch (e: any) { console.warn(`⚠️ screenshot ${name} failed: ${e.message}`); }
}

async function dumpHtml(page: import('playwright').Page, name: string) {
    const html = await page.content();
    await fs.writeFile(path.join(ARTIFACTS_DIR, `${name}.html`), html, 'utf8');
    console.log(`📄 ${name}.html (${(html.length / 1024).toFixed(1)} KB)`);
}

async function dumpInteractive(page: import('playwright').Page, name: string) {
    const items = await page.evaluate(() => {
        const out: Array<any> = [];
        const sel = 'button, [role="button"], a, [data-testid], [class*="Button" i], [class*="button" i]';
        const seen = new Set<HTMLElement>();
        document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
            if (seen.has(el)) return;
            seen.add(el);
            const text = (el.textContent || '').trim();
            if (!text || text.length > 200) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            out.push({
                tag: el.tagName,
                role: el.getAttribute('role') || undefined,
                text: text.slice(0, 120),
                href: (el as HTMLAnchorElement).href || undefined,
                testid: el.getAttribute('data-testid') || undefined,
                classes: (el.className || '').toString().slice(0, 100),
                visible: true,
            });
        });
        return out;
    });
    await fs.writeFile(path.join(ARTIFACTS_DIR, `${name}_interactive.json`), JSON.stringify(items, null, 2), 'utf8');
    console.log(`🔘 ${name}: ${items.length} interactive elements`);
    return items;
}

async function dismissOverlays(page: import('playwright').Page) {
    // Text-button overlays
    const labels = ['Вернуться позже', 'Позже', 'Понятно', 'Пропустить'];
    for (const label of labels) {
        try {
            const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
            if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
                await btn.click({ timeout: 1500 });
                console.log(`✖ dismissed text "${label}"`);
                await page.waitForTimeout(600);
            }
        } catch { /* fine */ }
    }
    // Icon-close (×) on top-right of cards / overlays — multiple times
    for (let pass = 0; pass < 4; pass++) {
        const closed = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll<HTMLElement>(
                'button[aria-label*="закрыт" i], button[aria-label*="close" i], [data-testid*="close" i], svg[class*="close" i]'
            ));
            for (const el of candidates) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    (el as HTMLElement).click();
                    return el.getAttribute('aria-label') || el.tagName;
                }
            }
            return null;
        });
        if (!closed) break;
        console.log(`✖ dismissed icon "${closed}"`);
        await page.waitForTimeout(400);
    }
}

async function main() {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    console.log(`🚀 order-actions probe`);
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

    let chosenDriverId = FORCED_DRIVER_ID;

    if (!chosenDriverId) {
    // ── STEP 1: list of active drivers, click row to discover yandexDriverId ──
    const listUrl = `https://fleet.yandex.ru/contractors?segment=active&statuses=on_order&park_id=${PARK_ID}`;
    console.log(`── STEP 1: active drivers ──\nnavigate -> ${listUrl}`);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    await dismissOverlays(page);
    await snap(page, '01_active_list');

    // The row anchors have href to the same /contractors?segment=... URL —
    // the actual yandexDriverId is added via SPA navigation when you click.
    // Strategy: click the first row whose text contains "На заказе", wait for
    // URL to gain a contractor_id=<id> param, then parse it.
    const beforeUrl = page.url();
    const clicked = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/contractors"]'));
        for (const a of anchors) {
            if (!/На заказе/.test(a.textContent || '')) continue;
            const r = a.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.top < 80) continue;
            a.click();
            return (a.textContent || '').trim().slice(0, 80);
        }
        return null;
    });
    if (!clicked) {
        console.error('❌ no clickable "На заказе" row found');
        await ctx.close(); process.exit(2);
    }
    console.log(`✅ clicked row: ${clicked}`);
    // Wait until URL changes to contain contractor_id
    let foundId: string | null = null;
    for (let i = 0; i < 30; i++) {
        const u = page.url();
        const m = u.match(/contractor_id=([a-f0-9]{24,})/);
        if (m) { foundId = m[1]; break; }
        await page.waitForTimeout(500);
    }
    if (!foundId) {
        console.error('❌ URL did not gain contractor_id after click. Current url:', page.url());
        await ctx.close(); process.exit(2);
    }
    chosenDriverId = foundId;
    console.log(`👤 yandexDriverId discovered: ${chosenDriverId}`);
    } else {
        console.log(`── STEP 1: skipped — using FORCED_DRIVER_ID=${chosenDriverId} ──`);
    }

    // ── STEP 2: driver's orders tab — widen period to last 30 days so
    //    "Пока ничего нет" doesn't hide today's active order if the default
    //    filter is too narrow.
    const periodFrom = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19) + 'Z';
    const periodTo   = new Date(Date.now() +  1 * 86400_000).toISOString().slice(0, 19) + 'Z';
    const ordersUrl = `https://fleet.yandex.ru/contractors/${chosenDriverId}/orders` +
        `?park_id=${PARK_ID}` +
        `&metrics_period_start=${encodeURIComponent(periodFrom)}` +
        `&metrics_period_end=${encodeURIComponent(periodTo)}`;
    console.log(`\n── STEP 2: driver's "Заказы" tab ──\nnavigate -> ${ordersUrl}`);
    await page.goto(ordersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    await dismissOverlays(page);
    await snap(page, '02_driver_orders');
    await dumpHtml(page, '02_driver_orders');

    // Per user guide (2026-06-08): the active order is the TOPMOST row that
    // does NOT have a "Дата завершения" set (the column shows a dash "—" or
    // is empty). We pick the first <tr> in the orders table where the row
    // has a numeric order code link AND lacks a "Выполнен"/"Отменён" status.
    const activeOrder = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('tr'));
        for (const row of rows) {
            const text = (row.textContent || '');
            // Skip header rows
            if (/^\s*(Статус|Код заказа|Исполнитель)/i.test(text)) continue;
            // Skip if row indicates terminal state — completed/cancelled orders
            // tend to show a "Дата завершения" timestamp and a green/red status.
            // The active order has a finished state of NONE — heuristic: skip rows
            // that explicitly contain "Выполнен" or "Отменён" in their status cell.
            if (/Выполнен|Отменён|Отменен/i.test(text)) continue;
            // Locate the order-code link (numeric, 6+ digits)
            const links = Array.from(row.querySelectorAll<HTMLAnchorElement>('a'));
            for (const a of links) {
                const t = (a.textContent || '').trim();
                if (/^\d{6,}$/.test(t)) {
                    return { href: a.href, code: t, rowText: text.slice(0, 120) };
                }
            }
        }
        // Fallback: pick the first numeric-text link inside main content area
        const fallbacks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'))
            .filter(a => /^\d{6,}$/.test((a.textContent || '').trim()))
            .filter(a => a.getBoundingClientRect().top > 200); // below header
        if (fallbacks.length > 0) {
            return { href: fallbacks[0].href, code: (fallbacks[0].textContent || '').trim(), rowText: '(fallback first numeric link)' };
        }
        return null;
    });
    if (!activeOrder) {
        console.warn('⚠️ no active order row found in this driver\'s table');
        console.warn('   The driver may have finished their order. Try again or pick a different driver.');
        await ctx.close(); process.exit(3);
    }
    console.log(`🚖 active order: code=${activeOrder.code}`);
    console.log(`   row: ${activeOrder.rowText.trim().slice(0, 80)}`);
    console.log(`   href: ${activeOrder.href}`);

    // ── STEP 3: open the order page ──
    console.log(`\n── STEP 3: open order page ──\nnavigate -> ${activeOrder.href}`);
    await page.goto(activeOrder.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    await dismissOverlays(page);
    await snap(page, '03_order_page');
    await dumpHtml(page, '03_order_page');
    const interactives = await dumpInteractive(page, '03_order_page');

    // Scan for the action vocabulary across visible interactives
    const wanted = /(Завершить|Отменить|Прервать|Закрыть заказ|Изменить статус|Действия|Снять с заказа)/i;
    const matches = interactives.filter((i: any) => wanted.test(i.text || ''));
    console.log(`\n🎯 candidate action buttons (${matches.length}):`);
    for (const m of matches) {
        console.log(`   - <${m.tag}> "${m.text}" ${m.testid ? `[data-testid=${m.testid}]` : ''} ${m.href ? `href=${m.href.slice(0, 60)}…` : ''}`);
    }
    if (matches.length === 0) {
        console.log('   none found in initial DOM. May be hidden under a "⋮" / "Действия" menu — see screenshot 03_order_page.png');
    }

    console.log(`\n✅ probe done — artifacts in ${ARTIFACTS_DIR}`);
    console.log(`   NO ACTION BUTTON WAS CLICKED.`);
    await ctx.close();
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
