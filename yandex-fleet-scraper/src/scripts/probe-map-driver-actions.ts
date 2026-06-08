/**
 * Probe the LEFT sidebar of the new fleet.yandex.ru /map/drivers/<id> page.
 * The active order details + action buttons live there. We scroll the sidebar
 * to the bottom and dump every clickable element / button-like control.
 *
 * Read-only: never clicks Завершить / Отменить.
 *
 *   PROBE_PARK_ID=45e30e9d6b824c608e5d28719cb19a6e \
 *   PROBE_DRIVER_ID=9a1a86d34e38462db8f5cfd3e3fbb2ac \
 *   npm run probe:map-driver-actions
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');
const ARTIFACTS_DIR = path.join(process.cwd(), '.artifacts', 'probe-map-driver-actions');
const PARK_ID = process.env.PROBE_PARK_ID || '45e30e9d6b824c608e5d28719cb19a6e';
const DRIVER_ID = process.env.PROBE_DRIVER_ID || '9a1a86d34e38462db8f5cfd3e3fbb2ac';

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

    const url = `https://fleet.yandex.ru/map/drivers/${DRIVER_ID}?park_id=${PARK_ID}`;
    console.log(`navigate -> ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '01_initial.png'), fullPage: true });

    // Find the sidebar container — it's the leftmost panel with the driver details.
    // Use heuristic: a tall narrow scrollable element on the left side.
    const sidebarInfo = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
        const candidates = all.filter(el => {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return r.left < 50 && r.top < 100 && r.width > 200 && r.width < 600 && r.height > 400 &&
                   (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
        });
        return candidates.slice(0, 5).map(el => ({
            tag: el.tagName,
            classes: (el.className || '').toString().slice(0, 80),
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        }));
    });
    console.log(`sidebar candidates:`, sidebarInfo);

    // Scroll the first scrollable sidebar to the bottom in multiple steps.
    await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
        const sidebar = all.find(el => {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return r.left < 50 && r.top < 100 && r.width > 200 && r.width < 600 && r.height > 400 &&
                   (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                   el.scrollHeight > el.clientHeight;
        });
        if (sidebar) {
            (window as any).__probeSidebar = sidebar;
            sidebar.scrollTop = sidebar.scrollHeight;
        }
        return !!sidebar;
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '02_scrolled_bottom.png'), fullPage: true });

    // Dump entire sidebar text + all interactive children
    const dump = await page.evaluate(() => {
        const sidebar = (window as any).__probeSidebar as HTMLElement | undefined;
        if (!sidebar) return null;
        const fullText = (sidebar.textContent || '').trim();
        const interactive: Array<any> = [];
        sidebar.querySelectorAll<HTMLElement>('button, [role="button"], a, [class*="utton" i]').forEach(el => {
            const t = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            interactive.push({
                tag: el.tagName,
                role: el.getAttribute('role') || undefined,
                text: t.slice(0, 100),
                href: (el as HTMLAnchorElement).href || undefined,
                classes: (el.className || '').toString().slice(0, 80),
                testid: el.getAttribute('data-testid') || undefined,
            });
        });
        return { fullText: fullText.slice(0, 2000), interactive };
    });
    if (dump) {
        await fs.writeFile(path.join(ARTIFACTS_DIR, 'sidebar_full_text.txt'), dump.fullText, 'utf8');
        await fs.writeFile(path.join(ARTIFACTS_DIR, 'sidebar_interactive.json'), JSON.stringify(dump.interactive, null, 2), 'utf8');
        console.log(`\nsidebar full text (truncated 2000):\n${dump.fullText}\n`);
        console.log(`\nsidebar interactive elements: ${dump.interactive.length}`);
        for (const e of dump.interactive) {
            console.log(`  <${e.tag}> "${e.text}" ${e.testid ? `[data-testid=${e.testid}]` : ''}`);
        }
    }

    // Final scan for action keywords anywhere on page (even if outside sidebar)
    const wholePage = await page.evaluate(() => {
        const out: Array<{ tag: string; text: string; xpath?: string }> = [];
        document.querySelectorAll<HTMLElement>('button, [role="button"], a, [class*="utton" i]').forEach(el => {
            const t = (el.textContent || '').trim();
            if (/(Завершить|Отменить|Прервать|Закрыть заказ|Аннулировать|Снять с заказа|Действия|⋮|\.\.\.)/i.test(t)) {
                out.push({ tag: el.tagName, text: t.slice(0, 100) });
            }
        });
        return out;
    });
    console.log(`\nwhole-page action-keyword matches: ${wholePage.length}`);
    for (const m of wholePage) console.log(`  <${m.tag}> "${m.text}"`);

    console.log(`\n✅ probe done. artifacts in ${ARTIFACTS_DIR}`);
    await ctx.close();
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
