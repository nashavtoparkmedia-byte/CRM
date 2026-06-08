/**
 * One-shot: find a driver's yandexDriverId by full name in the new
 * fleet.yandex.ru dispatcher.
 *
 *   PROBE_DRIVER_NAME='Коренько Артем' PROBE_PARK_ID=45e30e9d... npm run probe:find-driver-id
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-find-driver-id');
const PARK_ID = process.env.PROBE_PARK_ID || '45e30e9d6b824c608e5d28719cb19a6e';
const NAME = process.env.PROBE_DRIVER_NAME || 'Коренько Артем';

async function main() {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    const ctx = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized', '--lang=ru-RU'],
        locale: 'ru-RU',
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
    });
    await ctx.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
    const page = ctx.pages()[0] ?? await ctx.newPage();

    const url = `https://fleet.yandex.ru/contractors?park_id=${PARK_ID}`;
    console.log(`navigate -> ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Find the search input — placeholder "Поиск по имени, ВУ или позывному"
    const searchInput = page.getByPlaceholder(/Поиск по имени|ВУ или позывн/i).first();
    if (!await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.error('❌ search input not visible');
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'no_input.png'), fullPage: true });
        await ctx.close(); process.exit(2);
    }
    console.log(`typing "${NAME}"…`);
    await searchInput.fill(NAME);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'after_search.png'), fullPage: true });

    // Find the first <a href="...contractors?...">FULL_NAME...</a> row link
    const rowLink = page.locator('a[href*="/contractors"]').filter({ hasText: NAME }).first();
    if (!await rowLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.error(`❌ no row matching "${NAME}" — попробуй другое написание`);
        await ctx.close(); process.exit(3);
    }
    await rowLink.click({ timeout: 3000 });
    console.log('clicked first matching row, waiting for ?contractor_id=...');
    let foundId: string | null = null;
    for (let i = 0; i < 30; i++) {
        const u = page.url();
        const m = u.match(/contractor_id=([a-f0-9]{24,})/);
        if (m) { foundId = m[1]; break; }
        await page.waitForTimeout(500);
    }
    if (!foundId) {
        console.error(`❌ contractor_id not in URL: ${page.url()}`);
        await ctx.close(); process.exit(4);
    }
    console.log(`\n✅ FOUND: ${NAME}`);
    console.log(`   yandexDriverId = ${foundId}`);
    await ctx.close();
}

main().catch(e => { console.error('💥', e?.message || e); process.exit(1); });
