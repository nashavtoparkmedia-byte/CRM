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

const newBlock = `const clicked = await page.evaluate(() => {
                            // 1. Visual Geometry Locator
                            const h1s = Array.from(document.querySelectorAll('h1, h2, div'));
                            const h1 = h1s.find(el => {
                                const text = el.textContent || '';
                                return (text.trim() === 'Contractors' || text.trim() === 'Водители') && el.getBoundingClientRect().top < 200;
                            });
                            
                            if (h1) {
                                const h1Rect = h1.getBoundingClientRect();
                                const clickables = Array.from(document.body.querySelectorAll('*')).filter(el => {
                                    const style = window.getComputedStyle(el);
                                    const isClickable = style.cursor === 'pointer' || el.tagName.toLowerCase() === 'button' || el.tagName.toLowerCase() === 'a';
                                    if (!isClickable) return false;
                                    
                                    const rect = el.getBoundingClientRect();
                                    if (rect.width < 10 || rect.height < 10) return false;
                                    
                                    // Bounding box heuristic
                                    if (rect.top > h1Rect.bottom + 30 || rect.bottom < h1Rect.top - 30) return false;
                                    if (rect.left < h1Rect.right - 10) return false;
                                    if (rect.left > h1Rect.right + 400) return false; // Not global search
                                    
                                    return true;
                                });

                                const outermost = clickables.filter(el => !clickables.some(other => other !== el && other.contains(el)));
                                outermost.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

                                if (outermost.length >= 2) {
                                    (outermost[1] as HTMLElement).click();
                                    return true;
                                } else if (outermost.length === 1) {
                                    (outermost[0] as HTMLElement).click();
                                    return true;
                                }
                            }

                            // 2. Strict Semantic fallback
                            const btns = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
                            const semanticBtn = btns.find(b => {
                                const aria = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
                                return aria.includes('проверка водителя') || aria.includes('check driver');
                            });
                            
                            if (semanticBtn) {
                                (semanticBtn as HTMLElement).click();
                                return true;
                            }
                            return false;
                        });

                        `;

const newCode = code.slice(0, startIdx) + newBlock + code.slice(endIdx);
fs.writeFileSync('src/worker.ts', newCode);
console.log("worker.ts successfully updated with Visual Geometric locator!");
