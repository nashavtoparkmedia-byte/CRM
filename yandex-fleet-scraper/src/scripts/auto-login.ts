/**
 * Headed automated login into Yandex Passport, writing the session into
 * .bot_profile/ so the worker and probe scripts can reuse it.
 *
 * Credentials are read from env vars:
 *   YANDEX_LOGIN    — Yandex ID (without @yandex.ru)
 *   YANDEX_PASSWORD — password
 *
 * Pass them inline so they don't end up on disk:
 *   PowerShell: $env:YANDEX_LOGIN='...'; $env:YANDEX_PASSWORD='...'; npm run login:auto
 *   bash:       YANDEX_LOGIN=... YANDEX_PASSWORD='...' npm run login:auto
 *
 * The browser is visible (headed). If Yandex asks for 2FA / SMS / device
 * verification, you can answer in the visible window — the script just
 * waits for the dashboard URL.
 *
 * Never logs the password.
 */
import 'dotenv/config';
import path from 'path';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const LOGIN = process.env.YANDEX_LOGIN;
const PASSWORD = process.env.YANDEX_PASSWORD;
const PARK_ID = process.env.YANDEX_PARK_ID || '3a23295d8d714c03b61a17a6fc86601b';

if (!LOGIN || !PASSWORD) {
    console.error('❌ YANDEX_LOGIN and YANDEX_PASSWORD env vars are required.');
    process.exit(2);
}

const SUCCESS_HOSTS = ['fleet.yandex.ru'];

async function main() {
    console.log('🔐 auto-login into Yandex Passport');
    console.log(`   login   : ${LOGIN}`);
    console.log(`   profile : ${BOT_PROFILE_DIR}`);
    console.log('');

    const ctx = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
        headless: false,
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
    await ctx.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

    const page = ctx.pages()[0] ?? await ctx.newPage();

    console.log('navigate -> https://passport.yandex.ru/auth');
    await page.goto('https://passport.yandex.ru/auth', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ── Step 1: login ──
    try {
        const loginInput = page.locator('input[name="login"], input#passp-field-login').first();
        await loginInput.waitFor({ state: 'visible', timeout: 15000 });
        await loginInput.fill(LOGIN!);
        console.log('typed login');

        // Submit button on passport login page
        const submit = page.locator('button#passp\\:sign-in, button[type="submit"]').first();
        await submit.click();
        console.log('clicked submit');
    } catch (e: any) {
        console.warn('⚠️ login step issue (might already be logged in):', e.message);
    }

    // ── Step 2: password ──
    try {
        const passInput = page.locator('input[name="passwd"], input[type="password"]').first();
        await passInput.waitFor({ state: 'visible', timeout: 15000 });
        await passInput.fill(PASSWORD!);
        console.log('typed password (hidden)');

        const submit = page.locator('button#passp\\:sign-in, button[type="submit"]').first();
        await submit.click();
        console.log('clicked submit (password)');
    } catch (e: any) {
        console.warn('⚠️ password step issue:', e.message);
    }

    // ── Step 3: wait for landing ──
    console.log('\n⏳ waiting up to 120s for either fleet.yandex.ru or a 2FA challenge…');
    console.log('   If 2FA / SMS / captcha appears in the visible window — solve it manually.');
    const t0 = Date.now();
    let landed = false;
    while (Date.now() - t0 < 120_000) {
        await page.waitForTimeout(2000);
        const url = page.url();
        if (SUCCESS_HOSTS.some(h => url.includes(h)) || /id\.yandex\./.test(url) || /passport\.yandex\.ru\/profile/.test(url)) {
            landed = true;
            console.log(`✅ landed at ${url}`);
            break;
        }
        // hint: if we're stuck on passport but no obvious challenge — just go forward
        if (url.includes('passport.yandex.ru') && !url.includes('/auth')) {
            console.log(`(intermediate: ${url})`);
        }
    }
    if (!landed) {
        // Force navigation
        console.log('forcing navigate to fleet.yandex.ru…');
        await page.goto('https://fleet.yandex.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
    }

    // ── Step 4: park reachability ──
    const driverUrl = `https://fleet.yandex.ru/map/drivers?park_id=${PARK_ID}`;
    console.log(`\nchecking park reachability -> ${driverUrl}`);
    await page.goto(driverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const body = (await page.textContent('body')) || '';
    const noParks = /Парки не найдены/i.test(body);
    if (noParks) {
        console.error('\n❌ "Парки не найдены" — this Yandex ID does NOT have access to park', PARK_ID);
        console.error('   The account is logged in, but it must be added to the park as a сотрудник (Dispatcher) first.');
        console.error('   Owner of the park → диспетчерская → Сотрудники → Добавить → ', LOGIN);
        await page.screenshot({ path: path.join(process.cwd(), '.artifacts', 'auto-login-no-park.png'), fullPage: true }).catch(() => {});
    } else {
        console.log('✅ park reachable — session saved in .bot_profile/');
        await page.screenshot({ path: path.join(process.cwd(), '.artifacts', 'auto-login-ok.png'), fullPage: true }).catch(() => {});
    }

    await ctx.close();
}

main().catch((e) => {
    console.error('💥 auto-login failed:', e?.message || e);
    process.exit(1);
});
