const fs = require('fs');
let code = fs.readFileSync('src/worker.ts', 'utf8');

const startMatch = "console.log(`[Worker] Attempting to find and click the 'Driver Check' (person with magnifying glass) button...`);";
const endMatch = "await page.waitForTimeout(3000);\n                    } catch (e) {";

const startIdx = code.indexOf(startMatch);
const endIdx = code.indexOf("await page.waitForTimeout(3000);", startIdx);

if (startIdx === -1 || endIdx === -1) {
    console.error("Boundaries not found");
    process.exit(1);
}

const newBlock = `
                        // User Instructions:
                        // 1. Не искать кнопку глобально по странице.
                        // 2. Найти строку/карточку нужного подрядчика по имени/ID/номеру.
                        // 3. Искать target button только внутри этой строки.
                        // 4. Использовать устойчивые селекторы: getByRole, aria-label, title, data-testid/data-qa.
                        // 5. Не использовать nth(0), координаты, поиск по svg/icon.
                        // 6. Перед кликом дождаться, что строка подрядчика видима.
                        // 7. После клика проверить, что не открылось окно Search. Если открылось, значит выбран неверный элемент.
                        // 8. Добавь логирование: какой именно селектор найден и по какому тексту/атрибуту клик произошёл.

                        console.log(\`[Worker] Attempting to find contractor row for license: \${check.license}\`);
                        
                        // 2. & 6. Wait for the contractor row to be visible
                        const contractorRow = page.locator('tr, div[role="row"], div[role="listitem"], .contractor-row, [data-testid*="row"]').filter({ hasText: check.license }).first();
                        
                        try {
                            await contractorRow.waitFor({ state: 'visible', timeout: 15000 });
                        } catch (e) {
                            console.log(\`[Worker] ❌ Error: Contractor row containing license \${check.license} not found or not visible.\`);
                            // If the row isn't visible, we must abort because we can't fulfill rule #3
                            throw new Error('Contractor row is not visible on the screen');
                        }

                        console.log(\`[Worker] ✅ Contractor row is visible. Searching for Check button inside this specific row.\`);
                        
                        // 3. & 4. & 5. Find target inside the row using robust selectors, no coords, no nth()
                        const buttonLocators = [
                            { desc: 'getByRole button -> Проверка', loc: contractorRow.getByRole('button', { name: /Проверка/i }) },
                            { desc: 'getByRole button -> История', loc: contractorRow.getByRole('button', { name: /История/i }) },
                            { desc: 'getByRole button -> Проверить', loc: contractorRow.getByRole('button', { name: /Проверить/i }) },
                            { desc: 'getByRole link -> Проверка', loc: contractorRow.getByRole('link', { name: /Проверка/i }) },
                            { desc: 'aria-label / title -> Проверка', loc: contractorRow.locator('[aria-label*="Проверка"], [title*="Проверка"], [aria-label*="check"], [title*="check"]') },
                            { desc: 'data-testid / data-qa', loc: contractorRow.locator('[data-testid*="check"], [data-qa*="check"]') }
                        ];

                        let clicked = false;
                        let usedSelectorDesc = '';

                        for (const item of buttonLocators) {
                            if (await item.loc.count() > 0 && await item.loc.first().isVisible()) {
                                usedSelectorDesc = item.desc;
                                
                                // 8. Logging exact selector and trigger
                                console.log(\`[Worker] ✅ Found Check button! Selector used: \${usedSelectorDesc}\`);
                                await item.loc.first().click();
                                clicked = true;
                                break;
                            }
                        }

                        if (!clicked) {
                            console.log(\`[Worker] ❌ Failed to find Check button inside the contractor row.\`);
                            throw new Error('Check button not found inside contractor row');
                        }

                        // 7. Verify we didn't open the global Search modal
                        console.log(\`[Worker] Verifying the correct modal opened (not the Search modal)...\`);
                        await page.waitForTimeout(2000); // Give modal time to animate
                        
                        const searchModal = page.getByRole('dialog').filter({ hasText: /Start entering the name|Начните вводить/i });
                        if (await searchModal.count() > 0 && await searchModal.first().isVisible()) {
                            console.log(\`[Worker] ❌ ERROR: Opened the global Search window instead of Contractor Check! The chosen button was incorrect.\`);
                            await page.keyboard.press('Escape'); // Try to close it
                            throw new Error('Opened wrong modal (Global Search)');
                        }
                        
                        console.log(\`[Worker] ✅ Success: Correct modal opened, Global Search bypassed.\`);

                        // `;

const newCode = code.slice(0, startIdx) + newBlock + code.slice(endIdx);
fs.writeFileSync('src/worker.ts', newCode);
console.log("worker.ts successfully updated with Row-based Target Button Locator!");
