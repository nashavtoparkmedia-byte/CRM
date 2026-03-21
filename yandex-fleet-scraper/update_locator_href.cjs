const fs = require('fs');
let code = fs.readFileSync('src/worker.ts', 'utf8');

const startMatch = "const clicked = await page.evaluate(() => {";
const endMatch = "if (clicked) {";

const startIdx = code.indexOf(startMatch);
const endIdx = code.indexOf(endMatch, startIdx);

if (startIdx === -1 || endIdx === -1) {
    console.error("Could not find block boundaries!");
    process.exit(1);
}

const newBlock = `let clicked = false;
                        
                        // 1. We learned the button is actually an <a href> link pointing to /contractors/check
                        const hrefLocators = [
                                'a[href*="/check"]',
                                'a[href*="/contractors/check"]'
                        ];
                        
                        for (const selector of hrefLocators) {
                            try {
                                const link = page.locator(selector).first();
                                if (await link.isVisible()) {
                                    await link.click();
                                    clicked = true;
                                    break;
                                }
                            } catch (e) {
                                // Ignore timeout or visibility errors
                            }
                        }

                        // 2. Fallback to direct navigation via URL
                        if (!clicked) {
                            console.log('[Worker] Visually clicking failed. Directly navigating to Check URL...');
                            const currentUrl = page.url();
                            const urlObj = new URL(currentUrl);
                            const parkId = urlObj.searchParams.get('park_id');
                            if (parkId) {
                                await page.goto(\`https://fleet.yandex.ru/contractors/check?park_id=\${parkId}\`);
                                clicked = true;
                            } else {
                                // If parkId is somehow missing from URL, we try to go without park_id (Yandex might default)
                                await page.goto('https://fleet.yandex.ru/contractors/check');
                                clicked = true;
                            }
                        }

                        // Let the destination page (which contains the check input) load
                        await page.waitForTimeout(3000);

                        `;

const newCode = code.slice(0, startIdx) + newBlock + code.slice(endIdx);
fs.writeFileSync('src/worker.ts', newCode);
console.log("worker.ts successfully updated with direct HREF and URL navigation!");
