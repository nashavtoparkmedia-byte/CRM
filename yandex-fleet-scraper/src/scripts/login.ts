import 'dotenv/config';
import path from 'path';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');

async function main() {
    console.log('🚀 Starting manual login flow for fleet.yandex.ru...');
    console.log(`📁 Bot profile directory: ${BOT_PROFILE_DIR}`);
    console.log('');
    console.log('ℹ️  This will open a browser window. Log in to Yandex Fleet manually.');
    console.log('ℹ️  The session will be saved automatically to .bot_profile directory.');
    console.log('ℹ️  After saving, the worker will use this profile without needing to log in again.');
    console.log('');

    // Use launchPersistentContext — session cookies and local storage persist to disk in .bot_profile
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

    console.log('Navigating to https://fleet.yandex.ru ...');

    try {
        await page.goto('https://fleet.yandex.ru/', { timeout: 30000 });
    } catch (e: any) {
        console.warn('⚠️ Initial navigation failed (WAF?). Manually type the URL in the browser:', e.message);
    }

    console.log('');
    console.log('======================================================');
    console.log('👉 LOG IN MANUALLY IN THE OPENED BROWSER WINDOW');
    console.log('   Navigate to: https://fleet.yandex.ru');
    console.log('   Make sure you can see the drivers dashboard.');
    console.log('');
    console.log('🛑 THEN PRESS ENTER HERE IN THE TERMINAL 🛑');
    console.log('======================================================');
    console.log('');

    await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve());
    });

    console.log('✅ Confirmation received! Saving session (browser will close)...');

    // Give a moment for any pending cookies to settle
    await page?.waitForTimeout(1500);

    await context.close();

    console.log('');
    console.log('✅ Session saved to .bot_profile directory.');
    console.log('✅ You can now run: npm run start:worker');
    console.log('   The worker will use this persistent session automatically.');
}

main().catch(e => {
    console.error('❌ Login flow failed:', e);
    process.exit(1);
});
