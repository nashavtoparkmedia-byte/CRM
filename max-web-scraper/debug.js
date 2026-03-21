const { chromium } = require('playwright');
const fs = require('fs');

async function debug() {
    console.log('Запуск отладочного браузера...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    console.log('Переход на https://web.max.ru/...');
    await page.goto('https://web.max.ru/', { waitUntil: 'networkidle' });
    
    console.log('Ожидание 5 секунд для прогрузки интерфейса...');
    await page.waitForTimeout(5000);
    
    console.log('Сохранение скриншота debug_screenshot.png...');
    await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
    
    const content = await page.content();
    fs.writeFileSync('debug_content.html', content);
    
    console.log('Информация о элементах:');
    const canvasCount = await page.locator('canvas').count();
    const imgCount = await page.locator('img').count();
    console.log(`Canvas count: ${canvasCount}`);
    console.log(`Img count: ${imgCount}`);
    
    await browser.close();
    console.log('Готово.');
}

debug().catch(console.error);
