import type { Page } from 'playwright';

export interface ParsedHistory {
    checksLeft: number | null;
    profile: {
        name: string | null;
        ageAndDob: string | null;
        reportDate: string | null;
    } | null;
    activity: {
        totalOrders: number | null;
        experience: string | null;
        firstRide: string | null;
        lastRide: string | null;
        monthlyStats: {
            month: string;
            economy: number;
            comfort: number;
            kids: number;
            other: number;
            total: number;
        }[];
    } | null;
    quality: {
        rating: number | null;
    } | null;
    topReviews: Record<string, string>;
    otherParks: {
        car: string;
        company: string;
        dates: string;
        photoControl: string;
        balance: string;
    }[];
}

/**
 * Parses the Yandex Pro Driver History page using full DOM access.
 */
export async function parseDriverHistory(page: Page): Promise<ParsedHistory> {
    const data: ParsedHistory = {
        checksLeft: null,
        profile: null,
        activity: null,
        quality: null,
        topReviews: {},
        otherParks: []
    };

    try {
        // 1. Checks left
        const checksText = await page.locator(':text-matches("осталось \\\\d+ провер")').first().textContent().catch(() => null);
        if (checksText) {
            const match = checksText.match(/осталось (\d+) провер/);
            if (match && match[1]) data.checksLeft = parseInt(match[1], 10);
        }

        // 2. Profile
        const profileBox = page.locator('div:has-text("года, дата рождения")').last().locator('..').locator('..');
        if (await profileBox.isVisible().catch(() => false)) {
            const h2Text = await profileBox.locator('h2, [class*="title"]').first().textContent().catch(() => null);
            const ageText = await profileBox.locator(':text("года, дата рождения")').first().textContent().catch(() => null);
            const reportDate = await page.locator(':text-matches("Отчёт за")').first().textContent().catch(() => null);

            data.profile = {
                name: h2Text?.trim() || null,
                ageAndDob: ageText?.trim() || null,
                reportDate: reportDate?.replace('(Данные устарели)', '').trim() || null
            };
        }

        // 3. Activity
        const activitySection = page.locator(':has-text("Активность в сервисе")').last().locator('..');
        data.activity = { totalOrders: null, experience: null, firstRide: null, lastRide: null, monthlyStats: [] };

        const experienceText = await page.locator(':text-matches("Подключён к сервису")').locator('..').innerText().catch(() => '');
        const experienceMatch = experienceText.match(/(?:Подключён к сервису)[\s\S]*?(\d+ год.*?)\n/i) || experienceText.match(/\d+ (?:год|лет|мес|дн)[^\n]*/);
        data.activity.experience = experienceMatch ? (experienceMatch[0] ? experienceMatch[0].trim() : null) : null;

        const firstRideMatch = experienceText.match(/Первая поездка\s*—\s*([\d.]+)/i);
        data.activity.firstRide = firstRideMatch ? (firstRideMatch[1] ? firstRideMatch[1] : null) : null;

        const lastRideMatch = experienceText.match(/последняя\s*—\s*([\d.]+)/i);
        data.activity.lastRide = lastRideMatch ? (lastRideMatch[1] ? lastRideMatch[1] : null) : null;

        const totalOrdersMatch = await page.locator(':text-matches("Всего \\\\d+ заказ")').first().textContent().catch(() => '');
        if (totalOrdersMatch) {
            const match = totalOrdersMatch.match(/Всего (\d+) заказ/);
            if (match && match[1]) data.activity.totalOrders = parseInt(match[1], 10);
        }

        // Hover over charts to get monthly stats
        const bars = page.locator('svg rect');
        const numBars = await bars.count().catch(() => 0);

        let lastHoveredMonth = '';
        for (let i = 0; i < numBars; i++) {
            try {
                const bar = bars.nth(i);
                const box = await bar.boundingBox();
                // Only hover reasonably sized visible bars that are likely part of the chart
                if (box && box.width > 5 && box.height > 5) {
                    await bar.hover({ force: true, timeout: 1000 }).catch(() => { });
                    await page.waitForTimeout(50); // Give tooltip time to render

                    const tooltip = page.locator('[class*="tooltip"], [class*="Popup"]');
                    if (await tooltip.count() > 0 && await tooltip.first().isVisible()) {
                        const tooltipText = await tooltip.first().innerText();
                        const tNormal = tooltipText.replace(/\n/g, ' ').replace(/\u00A0/g, ' ');
                        const topDateMatch = tNormal.match(/(\d{2}\.\d{2}\.\d{4})/);

                        if (topDateMatch && topDateMatch[1] && topDateMatch[1] !== lastHoveredMonth) {
                            lastHoveredMonth = topDateMatch[1] || '';

                            const economyMatch = tNormal.match(/Эконом\s+(\d+)/i);
                            const comfortMatch = tNormal.match(/Комфорт\s+(\d+)/i);
                            const kidsMatch = tNormal.match(/Детский\s+(\d+)/i);
                            const otherMatch = tNormal.match(/Остальные\s+(\d+)/i);
                            const totalMatch = tNormal.match(/Всего\s+(\d+)/i);

                            const economy = economyMatch ? parseInt(economyMatch[1] || '0', 10) : 0;
                            const comfort = comfortMatch ? parseInt(comfortMatch[1] || '0', 10) : 0;
                            const kids = kidsMatch ? parseInt(kidsMatch[1] || '0', 10) : 0;
                            const other = otherMatch ? parseInt(otherMatch[1] || '0', 10) : 0;
                            const total = totalMatch ? parseInt(totalMatch[1] || '0', 10) : 0;

                            data.activity.monthlyStats.push({ month: lastHoveredMonth, economy, comfort, kids, other, total });
                        }
                    }
                }
            } catch (e) {
                // Ignore hover errors for individual bars
            }
        }
        // Move mouse away to hide tooltip
        await page.mouse.move(0, 0).catch(() => { });

        // 4. Quality (Rating)
        const ratingLoc = page.locator(':text("Рейтинг")').locator('..').locator('text=/[45],[0-9]{2}/').first();
        if (await ratingLoc.isVisible().catch(() => false)) {
            const ratingText = await ratingLoc.textContent();
            if (ratingText) data.quality = { rating: parseFloat(ratingText.replace(',', '.')) };
        }

        // 5. Top Reviews
        const reviewsSection = page.locator(':has-text("Топ отзывов")').last().locator('..');
        if (await reviewsSection.isVisible().catch(() => false)) {
            // Find rows looking like: "Вежливость чаще на 70%"
            // Often inside simple flex rows
            const reviewElements = await page.evaluate(() => {
                const reviews: Record<string, string> = {};
                // Find title
                const headers = Array.from(document.querySelectorAll('h2, h3, div')).filter(e => e.textContent?.includes('Топ отзывов'));
                if (headers.length === 0) return reviews;

                const section = headers[headers.length - 1]?.parentElement as HTMLElement;
                if (!section) return reviews;

                // Usually rows have 2 spans/divs: Key and Value. We'll find all text nodes up to a certain depth and pair them.
                const rows = Array.from(section.querySelectorAll('div > div:nth-child(n+2)')); // skip header usually
                // Heuristic parsing due to obfuscated classes
                const allTexts = Array.from(section.innerText.split('\n')).map((t: string) => t.trim()).filter((t: string) => t.length > 0 && t !== 'Топ отзывов' && !t.includes('Количество отзывов'));

                for (let i = 0; i < allTexts.length - 1; i += 2) {
                    const key = allTexts[i];
                    const val = allTexts[i + 1];
                    if (key && val && key.length < 40 && val.length < 40) {
                        reviews[key] = val;
                    }
                }
                return reviews;
            }).catch(() => ({}));
            data.topReviews = reviewElements;
        }

        // 6. External Parks Table
        const parksSection = page.locator(':has-text("В других таксопарках")').last().locator('..');
        if (await parksSection.isVisible().catch(() => false)) {
            data.otherParks = await page.evaluate(() => {
                const parks: any[] = [];
                const headers = Array.from(document.querySelectorAll('h2, h3, div')).filter(e => e.textContent?.includes('В других таксопарках'));
                if (headers.length === 0) return parks;

                const section = headers[headers.length - 1]?.parentElement as HTMLElement;
                if (!section) return parks;

                // Assuming it's a grid/table. Look for rows that contain brand names or expected columns
                // Best simple heuristic is finding elements with long text content containing standard strings like "Нет долга" or dates
                const rows = Array.from(section.children).filter(el => {
                    const t = el.textContent || '';
                    return (t.includes('Нет долга') || t.includes('Долг') || /\d{4} г\./.test(t)) && !t.includes('В других таксопарках');
                });

                for (const row of rows) {
                    const cols = Array.from(row.querySelectorAll('div > span, div > div')).map(e => e.textContent?.trim()).filter(t => t && t.length > 0);
                    // Combine into string for simplicity if pure column extraction is too flaky due to CSS obfuscation
                    // Let's try to extract based on known patterns instead
                    const textContent = (row as HTMLElement).innerText.split('\n').map((t: string) => t.trim()).filter((t: string) => t.length > 0);

                    if (textContent.length >= 4) {
                        // Very rough heuristic
                        const car = textContent[0] + ' ' + (textContent[1] && textContent[1].includes('*') ? textContent[1] : '');
                        const company = textContent.find((t: string) => t !== car && !t.includes('г.') && !t.includes('Нет') && !t.includes('Долг')) || textContent[2] || '';
                        const dates = textContent.find((t: string) => t.includes('г.')) || '';
                        const balance = textContent.find((t: string) => t.includes('долг') || t.includes('Долг')) || '';
                        const photo = textContent.find((t: string) => t.toLowerCase() === 'нет' || t.toLowerCase() === 'да') || '';

                        parks.push({
                            car: car.trim(),
                            company: company.replace(car, '').trim(),
                            dates: dates.trim(),
                            photoControl: photo.trim(),
                            balance: balance.trim(),
                            rawText: textContent.join(' | ') // Fallback for CRM
                        });
                    }
                }
                return parks;
            }).catch(() => []);
        }

    } catch (e: any) {
        console.error(`[Worker] Error in parsing DOM: ${e.message}`);
        // don't throw, return partial data 
    }

    return data;
}
