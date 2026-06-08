/**
 * One-shot probe: open fleet.yandex.ru with .bot_profile/ session, click the
 * park badge in the top-right corner, dump all parks visible in the dropdown.
 *
 *   npm run probe:parks
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-parks');

async function main() {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
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
    const page = ctx.pages()[0] ?? await ctx.newPage();

    console.log('navigate -> https://fleet.yandex.ru/');
    await page.goto('https://fleet.yandex.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '01_landing.png'), fullPage: true }).catch(() => {});

    // The park badge in the top-right corner. From the user's screenshot, it
    // shows a 2-letter avatar + park name + city. We try a few heuristics.
    console.log('looking for park badge in top-right corner…');
    let clicked = false;
    const candidates: Array<{ name: string; locator: import('playwright').Locator }> = [
        { name: 'aria role button containing "Наш Автопарк"', locator: page.getByRole('button', { name: /Наш Автопарк|автопарк|Yoko/i }).first() },
        { name: 'button[class*="park"]', locator: page.locator('button[class*="park" i], div[class*="park-switcher" i]').first() },
        { name: 'top-right button with city', locator: page.locator('header button:has-text("Екатеринбург"), header [role="button"]:has-text("Екатеринбург")').first() },
        { name: 'fallback: any header button', locator: page.locator('header button, [class*="Header"] button').last() },
    ];
    for (const c of candidates) {
        try {
            if (await c.locator.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`  trying: ${c.name}`);
                await c.locator.click({ timeout: 3000 });
                clicked = true;
                console.log(`  ✅ clicked`);
                break;
            }
        } catch { /* try next */ }
    }
    if (!clicked) {
        console.warn('⚠️ could not click any park badge; screenshot of landing only');
    } else {
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, '02_dropdown.png'), fullPage: true }).catch(() => {});
    }

    // Dump all visible text items that look like park names (city words)
    const candidatesText = await page.evaluate(() => {
        const cityWords = /Екатеринбург|Москва|Санкт-Петербург|Казань|Ярославль|Уфа|Краснодар|Сочи|Челябинск|Нальчик|Самара|Воронеж|Ростов|Новосибирск/;
        const result: Array<{ text: string; tag: string; classes: string }> = [];
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
            const text = (el.textContent || '').trim();
            if (text.length > 0 && text.length < 80 && cityWords.test(text) && el.children.length <= 3) {
                result.push({
                    text: text.slice(0, 80),
                    tag: el.tagName,
                    classes: (el.className || '').toString().slice(0, 100),
                });
            }
        });
        return result;
    });
    await fs.writeFile(path.join(ARTIFACTS_DIR, 'parks_text_dump.json'), JSON.stringify(candidatesText, null, 2), 'utf8');
    console.log(`\n📋 found ${candidatesText.length} text node(s) containing city words:`);
    const seen = new Set<string>();
    for (const it of candidatesText) {
        if (!seen.has(it.text)) {
            seen.add(it.text);
            console.log(`   ${it.text}`);
        }
    }

    await ctx.close();
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
