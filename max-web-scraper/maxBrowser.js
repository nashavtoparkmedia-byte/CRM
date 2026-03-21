const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fetch = typeof global.fetch === 'function' ? global.fetch : require('node-fetch');

function logToFile(msg) {
    try {
        const timestamp = new Date().toISOString();
        const formattedMsg = `[${timestamp}] [PID:${process.pid}] ${msg}\n`;
        fs.appendFileSync(path.join(__dirname, 'debug.log'), formattedMsg);
    } catch (e) {}
    console.log(`[PID:${process.pid}] ${msg}`);
}

class MaxBrowser {
    constructor() {
        this.context = null;
        this.page = null;
        this.userDataDir = path.join(__dirname, 'user_data');
        this.isLoggedIn = false;
        this.isSendingMessage = false;
        this.pollInterval = null;
        this.lastSeenUnreadPath = path.join(__dirname, 'last_seen_dedupe.json');
        this.DEDUP_TTL_MS = 300000; // 300 seconds (5 min) — after this, same text is allowed again
        this.lastSeenUnread = this.loadDedupeCache();
        this.recentlySentMessages = new Map(); // text -> timestamp (ms)
    }

    loadDedupeCache() {
        // TTL-based dedup: Map<key, timestamp>. Entries older than DEDUP_TTL_MS are ignored.
        try {
            if (fs.existsSync(this.lastSeenUnreadPath)) {
                const data = JSON.parse(fs.readFileSync(this.lastSeenUnreadPath, 'utf8'));
                if (Array.isArray(data)) {
                    // Migrate old format (plain array of strings) -> Map with current timestamp  
                    const map = new Map();
                    // Don't migrate old entries — they're stale and would block messages
                    logToFile(`[DEDUP] Loaded cache, discarding ${data.length} stale entries from old format`);
                    return map;
                }
                if (typeof data === 'object' && !Array.isArray(data)) {
                    // New format: { key: timestamp }
                    const map = new Map();
                    const now = Date.now();
                    for (const [key, ts] of Object.entries(data)) {
                        if (now - ts < this.DEDUP_TTL_MS) {
                            map.set(key, ts);
                        }
                    }
                    logToFile(`[DEDUP] Loaded ${map.size} active entries (pruned expired)`);
                    return map;
                }
            }
        } catch (e) {
            logToFile('Ошибка загрузки кэша дедупликации: ' + e.message);
        }
        return new Map();
    }

    saveDedupeCache() {
        try {
            // Prune to keep only the newest 5000 entries
            let entries = Array.from(this.lastSeenUnread.entries());
            if (entries.length > 5000) {
                entries = entries.slice(entries.length - 5000);
            }
            const pruned = Object.fromEntries(entries);
            fs.writeFileSync(this.lastSeenUnreadPath, JSON.stringify(pruned), 'utf8');
        } catch (e) {
            logToFile('Ошибка сохранения кэша дедупликации: ' + e.message);
        }
    }

    async restart() {
        logToFile('Начало restart()...');
        try {
            if (this.context) {
                await Promise.race([
                    this.context.close(),
                    new Promise(r => setTimeout(r, 3000))
                ]);
            }
        } catch(e) {
            logToFile('Ошибка при закрытии контекста: ' + e.message);
        }

        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
        
        try {
             fs.rmSync(this.userDataDir, { recursive: true, force: true });
        } catch(e) {}
        
        setTimeout(() => {
            this.init().catch(e => logToFile('Ошибка при асинхронном restart -> init: ' + e.message));
        }, 1000);
    }

    async init() {
        logToFile('Начало init()...');
        try {
            if (!fs.existsSync(this.userDataDir)) {
                fs.mkdirSync(this.userDataDir, { recursive: true });
            }

            logToFile('Запуск chromium.launchPersistentContext()...');
            this.context = await chromium.launchPersistentContext(this.userDataDir, {
                headless: true,
                viewport: { width: 1280, height: 720 },
                args: [
                    '--disable-blink-features=AutomationControlled', 
                    '--no-sandbox', 
                    '--disable-setuid-sandbox'
                ]
            });
            
            this.page = this.context.pages()[0] || await this.context.newPage();
            
            // Скрытие признаков автоматизации
            await this.page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            
            this.page.on('console', msg => {
                const text = msg.text();
                logToFile('БРАУЗЕР: ' + text);
                if (text.includes('user logged in')) {
                    logToFile('БРАУЗЕР (Console): Подтвержден логин.');
                }
            });
            this.page.on('pageerror', err => logToFile('ОШИБКА БРАУЗЕРА: ' + err.message));

            logToFile('Переход на https://web.max.ru/ ...');
            await this.page.goto('https://web.max.ru/', { waitUntil: 'networkidle', timeout: 60000 });
            
            await this.page.waitForTimeout(2000);
            await this.checkAuth();
        } catch (error) {
            logToFile('ОШИБКА в init(): ' + error.stack);
            throw error;
        }
    }

    async checkAuth() {
        logToFile('Начало checkAuth()...');
        try {
            let attempts = 0;
            const maxAttempts = 30;

            while (attempts < maxAttempts) {
                if (!this.page) return;
                const url = this.page.url();
                logToFile(`Попытка детекции #${attempts + 1}... URL: ${url}`);
                
                const loggedInMarkers = [
                    '.chat-list', 
                    '.chat-item', 
                    'button[aria-label*="Написать"]',
                    '.avatar',
                    '.side-bar',
                    '.search-input',
                    'input[placeholder*="Найти"]'
                ];
                
                let foundMarker = false;
                for (const selector of loggedInMarkers) {
                    if (await this.page.$(selector)) {
                        logToFile(`МАРКЕР НАЙДЕН: ${selector}. Авторизация подтверждена.`);
                        foundMarker = true;
                        break;
                    }
                }

                if (foundMarker || url.includes('/chat') || url.includes('/messaging') || url.match(/\d+$/)) {
                    logToFile(`ИНТЕРФЕЙС ЧАТОВ НАЙДЕН! (Marker: ${foundMarker}, URL: ${url}). Авторизация подтверждена.`);
                    this.isLoggedIn = true;
                    this._loggedInSince = Date.now();
                    this.startPassivePolling();
                    try {
                        await this.context.storageState({ path: path.join(this.userDataDir, 'state.json') });
                    } catch(e) {}
                    return;
                }

                const bodyText = await this.page.evaluate(() => document.body.innerText.trim());
                if (bodyText.length < 10 && attempts > 5) {
                    logToFile('ВНИМАНИЕ: Похоже на пустую страницу. Пробую перезагрузку...');
                    await this.page.reload({ waitUntil: 'networkidle' });
                    await this.page.waitForTimeout(3000);
                }

                const refreshBtn = this.page.locator('button:has-text("Обновить"), button[aria-label*="Обновить"]');
                if (await refreshBtn.count() > 0) {
                    logToFile('Найдена кнопка обновления QR. Нажимаю...');
                    try {
                        await refreshBtn.first().click();
                        await this.page.waitForTimeout(2000);
                    } catch(e) {}
                }

                const qrElement = await this.findQrElement();
                if (qrElement) {
                    const ts = Date.now();
                    const qrPath = `last_qr.png`; 
                    try {
                        await qrElement.screenshot({ path: qrPath });
                        await qrElement.screenshot({ path: path.join(this.userDataDir, 'last_qr.png') });
                        logToFile(`Файл last_qr.png обновлен (${ts}).`);
                    } catch(e) {}
                } else {
                    logToFile('QR не найден. Возможно, идет загрузка или переход...');
                    await this.page.screenshot({ path: 'debug_state.png' });
                }

                logToFile('Ожидание (5 сек)...');
                await this.page.waitForTimeout(5000);
                attempts++;
            }
        } catch (error) {
            logToFile(`ОШИБКА в checkAuth: ${error.message}`);
        }
    }

    async findQrElement() {
        const canvas = await this.page.$('canvas');
        if (canvas) return this.page.locator('canvas').first();
        
        const svg = await this.page.$('svg:has(image)');
        if (svg) return this.page.locator('svg:has(image)').first();

        return null;
    }

    startPassivePolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        logToFile('Запуск пассивного обработчика входящих сообщений (interval=2000ms)...');
        
        let lastLoggedDomState = '';

        this.pollInterval = setInterval(async () => {
            if (!this.isLoggedIn || !this.page) return;

            try {
                if (!this._hasDumpedDom && this._loggedInSince) {
                    if (Date.now() - this._loggedInSince > 10000) {
                        try {
                            const html = await this.page.innerHTML('body');
                            this._hasDumpedDom = true;
                            fs.writeFileSync(path.join(__dirname, 'max_dom_dump.txt'), html);
                            logToFile('DUMPED FULL MAX WEB DOM TO max_dom_dump.txt (10s delay)');
                        } catch(e) {
                            logToFile('FAILED TO DUMP DOM: ' + e.message);
                        }
                    }
                }

                const now = Date.now();
                
                // Очистка старых отправленных (старше 120 сек)
                for (const [txt, ts] of this.recentlySentMessages.entries()) {
                    if (now - ts > 120000) this.recentlySentMessages.delete(txt);
                }

                const incomingData = await this.page.evaluate(() => {
                    const newMessages = [];
                    const debugStats = { unreadItemsText: [], activeChatMsgCount: 0, headerText: null };

                    // 1. Sidebar: чтение последнего сообщения из каждого чата
                    const items = document.querySelectorAll('.item.svelte-rg2upy');
                    
                    items.forEach(item => {
                        const nameEl = item.querySelector('.title, [class*="name"]');
                        const msgEl = item.querySelector('span.text.svelte-q2jdqb, .message-preview, .last-message');
                        
                        const nameText = nameEl ? nameEl.innerText.trim() : '';
                        const msgText = msgEl ? msgEl.innerText.trim() : '';
                        
                        const itemTitle = item.getAttribute('title') || '';
                        const itemSub = item.querySelector('.subtitle, .phone, .info, .status')?.innerText.trim() || '';
                        
                        let extraInfo = (itemTitle + ' ' + itemSub).trim();
                        if (!extraInfo) {
                            extraInfo = item.innerText.trim();
                        }

                        if (nameText && msgText && nameText !== msgText) {
                            if (msgText.startsWith('Вы:') || msgText.startsWith('You:')) {
                                return;
                            }

                            debugStats.unreadItemsText.push(`${nameText}|${msgText}`);
                            
                            newMessages.push({
                                source: 'sidebar',
                                name: nameText,
                                text: msgText,
                                extraInfo: extraInfo
                            });
                        }
                    });

                    // 2. Active chat: читаем ВСЕ входящие bubbles (не только последний!)
                    const mainArea = document.querySelector('main');
                    if (mainArea) {
                        const header = mainArea.querySelector('.chat-header, .top-bar, .user-name, header');
                        const headerEl = header?.querySelector('.title, .header-title, h2, .name') || mainArea.querySelector('.title, .header-title, h2, .name');
                        const subtitleEl = header?.querySelector('.subtitle, .phone, .info, .status');
                        
                        let extraInfo = subtitleEl ? subtitleEl.innerText.trim() : '';
                        if (header && !extraInfo) {
                            const allHeaderText = header.innerText.trim();
                            const nameText = headerEl?.innerText.trim() || '';
                            if (allHeaderText !== nameText) {
                                extraInfo = allHeaderText.replace(nameText, '').trim();
                            }
                        }

                        const allMsgs = mainArea.querySelectorAll('.message-item, .bubble, .text.svelte-q2jdqb');
                        
                        if (headerEl && allMsgs.length > 0) {
                            debugStats.headerText = headerEl.innerText.trim();
                            
                            if (!extraInfo) {
                                const sideItems = document.querySelectorAll('aside .item');
                                for (const sItem of sideItems) {
                                    const hasActive = sItem.querySelector('.button--active, .active, .selected, [aria-selected="true"]');
                                    if (hasActive) {
                                        extraInfo = sItem.querySelector('.subtitle, .phone, .info')?.innerText.trim() || '';
                                        if (!extraInfo) extraInfo = sItem.innerText.trim();
                                        break;
                                    }
                                }
                            }

                             // Читаем ВСЕ bubbles 
                             const maxCount = Math.min(allMsgs.length, 50); // Увеличим до 50 для надежности
                             const startIdx = allMsgs.length - maxCount;
                             
                             let inboundCount = 0;
                             
                             // 2.1 REVERSE TALLY
                             // Подсчет дублей снизу-вверх гарантирует стабильность ID, 
                             // даже если старые сообщения пропадают сверху (сдвиг окна).
                             const reverseTally = {};
                             const assignedOccurrences = new Array(allMsgs.length);
                             for (let i = allMsgs.length - 1; i >= startIdx; i--) {
                                 const msgEl = allMsgs[i];
                                 const textElForCheck = msgEl.querySelector('.selectable-text, .text, span, p') || msgEl;
                                 const rect = textElForCheck.getBoundingClientRect();
                                 const parentRect = msgEl.parentElement?.getBoundingClientRect() || { width: window.innerWidth, left: 0 };
                                 const isRightAligned = rect.left > (window.innerWidth / 2 + 100) || rect.right > (window.innerWidth - 200);
                                 const isOutgoing = msgEl.className.includes('message-out') || msgEl.className.includes('outgoing') || msgEl.className.includes('is-out') || isRightAligned;
                                 
                                 if (!isOutgoing) {
                                     const textEl = msgEl.querySelector('.selectable-text, .text, span') || msgEl;
                                     const text = textEl.innerText.trim();
                                     if (text) {
                                         reverseTally[text] = (reverseTally[text] || 0) + 1;
                                         assignedOccurrences[i] = reverseTally[text];
                                     }
                                 }
                             }

                             for (let i = startIdx; i < allMsgs.length; i++) {
                                 const msgEl = allMsgs[i];
                                 const textElForCheck2 = msgEl.querySelector('.selectable-text, .text, span, p') || msgEl;
                                 const rect2 = textElForCheck2.getBoundingClientRect();
                                 const parentRect2 = msgEl.parentElement?.getBoundingClientRect() || { width: window.innerWidth, left: 0 };
                                 const isRightAligned2 = rect2.left > (window.innerWidth / 2 + 100) || rect2.right > (window.innerWidth - 200);
                                 const isOutgoing = msgEl.className.includes('message-out') || msgEl.className.includes('outgoing') || msgEl.className.includes('is-out') || isRightAligned2;
                                 
                                 if (!isOutgoing) {
                                     const textEl = msgEl.querySelector('.selectable-text, .text, span') || msgEl;
                                     const text = textEl.innerText.trim();
                                     
                                     const occurrenceId = assignedOccurrences[i] || 1;
                                     
                                     // Игнорируем data-mid, так как при навигации React пересоздает DOM, и injected ID сбиваются (вызывая вал старых сообщений)
                                     let msgId = `rev_occ_${occurrenceId}`;
                                     
                                     const timeEl = msgEl.querySelector('time, .time, .message-time');
                                     const timeStr = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText.trim()) : '';
                                     
                                     if (text && text !== debugStats.headerText) {
                                         newMessages.push({
                                             source: 'active_chat',
                                             name: debugStats.headerText,
                                             text: text,
                                             extraInfo: extraInfo,
                                             msgId: msgId,
                                             timeStr: timeStr,
                                             bubbleIndex: i,
                                             occurrenceId: occurrenceId
                                         });
                                         inboundCount++;
                                     }
                                 }
                             }
                            debugStats.activeChatMsgCount = inboundCount;
                        }
                    }

                    return { newMessages, debugStats };
                });

                // Диагностическое логирование
                const currentStateStr = JSON.stringify(incomingData.debugStats);
                if (currentStateStr !== lastLoggedDomState) {
                    lastLoggedDomState = currentStateStr;
                    logToFile(`[POLL DOM] Header: "${incomingData.debugStats.headerText || 'none'}", ActiveInbound: ${incomingData.debugStats.activeChatMsgCount}, UnreadChats: ${incomingData.debugStats.unreadItemsText.length}`);
                }

                for (const msg of incomingData.newMessages) {
                    if (!msg.name || !msg.text || msg.text.length < 1) continue;
                    
                    msg.name = msg.name.replace(/\n/g, ' ').trim();
                    
                    let phoneMatch = msg.name.match(/[\+\d\s\-\(\)]{10,}/);
                    if (!phoneMatch && msg.extraInfo) {
                        phoneMatch = msg.extraInfo.match(/[\+\d\s\-\(\)]{10,}/);
                    }
                    
                    const phone = phoneMatch ? phoneMatch[0].replace(/\D/g, '') : msg.name;
                    
                    // Improved dedup key: INCLUDE timeStr so we know exact message
                    const dedupeKey = msg.msgId && !msg.msgId.startsWith('occ_') && !msg.msgId.startsWith('rev_occ_')
                        ? `${msg.source}:${phone}:${msg.msgId}`
                        : `${msg.source}:${phone}:${msg.text}:${msg.timeStr}:rev_occ_${msg.occurrenceId || 0}`;

                    // 0. Echo suppression
                    let isEcho = false;
                    for (const [sentText, ts] of this.recentlySentMessages.entries()) {
                        if (msg.text.includes(sentText) || sentText.includes(msg.text)) {
                            isEcho = true;
                            break;
                        }
                    }
                    if (isEcho) {
                        logToFile(`[DEDUPE] Echo suppressed: channel=max phone=${phone} text="${msg.text.substring(0, 20)}..."`);
                        // IMPORTANT FIX: Permanently cache the dedupe key so that when Echo Suppression expires (15s),
                        // this message doesn't suddenly appear as a new INBOUND message!
                        this.lastSeenUnread.set(dedupeKey, Date.now());
                        continue;
                    }

                    // Eternal Dedup (Bounded by size, not time). If we've seen it, ignore it.
                    const hasSeen = this.lastSeenUnread.has(dedupeKey);
                    
                    if (!hasSeen) {
                        this.lastSeenUnread.set(dedupeKey, Date.now());
                        
                        // Prune old entries periodically to prevent memory leak
                        if (this.lastSeenUnread.size > 10000) {
                            const entries = Array.from(this.lastSeenUnread.entries());
                            this.lastSeenUnread = new Map(entries.slice(entries.length - 8000));
                        }
                        
                        this.saveDedupeCache();
                        
                        // Ignore system messages
                        if (msg.text.includes('настроил исчезающие') || msg.text.includes('сообщение удалено')) continue;

                        logToFile(`[INBOUND] NEW channel=max source=${msg.source} phone=${phone} name="${msg.name}" msgId=${msg.msgId || 'none'} text="${msg.text.substring(0, 50).replace(/\n/g, ' ')}"`);
                        
                        try {
                            const crmUrl = process.env.CRM_WEBHOOK_URL || 'http://127.0.0.1:3002/api/webhook/max';
                            const response = await fetch(crmUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    phone: phone,
                                    driverName: msg.name,
                                    text: msg.text,
                                    timestamp: new Date().toISOString()
                                })
                            });
                            const respText = await response.text();
                            logToFile(`[INBOUND RESP] Status: ${response.status}, Body: ${respText.substring(0, 150)}`);
                        } catch(err) {
                            logToFile(`[INBOUND ERROR] Webhook failed: ${err.message}`);
                        }
                    } else {
                        // Log dedup hits for diagnostics
                        logToFile(`[DEDUPE] Skipped (already seen): channel=max source=${msg.source} phone=${phone} text="${msg.text.substring(0, 20)}"`);
                    }
                }
            } catch (e) {
                // Ignore errors (context could be destroyed during navigation)
            }
        }, 2000); 
    }
    async sendMessage(phone, text, name = "") {
        if (!this.isLoggedIn) {
            logToFile('Сессия не активна, быстрый чек...');
            const markers = ['.avatar', '.chat-list', '.search-input'];
            let found = false;
            for (const m of markers) {
                if (await this.page.$(m)) { found = true; break; }
            }
            if (!found) {
                logToFile('Авторизация не подтверждена, запускаю полный checkAuth...');
                await this.checkAuth(); 
            } else {
                this.isLoggedIn = true;
            }
            if (!this.isLoggedIn) throw new Error('Не авторизован в MAX');
        }
        
        logToFile(`[STEP 0] Старт отправки на ${phone} (Name: "${name || 'N/A'}")`);
        
        // Ожидание завершения других операций
        let waitAttempts = 0;
        while (this.isSendingMessage && waitAttempts < 15) {
            logToFile(`Ожидаем освобождения браузера... (${waitAttempts + 1}/15)`);
            await new Promise(r => setTimeout(r, 2000));
            waitAttempts++;
        }
        
        this.isSendingMessage = true;
        
        // 0. ОЧИСТКА - Закрываем все открытые модалки через JS для надежности
        try {
            const closedCount = await this.page.evaluate(() => {
                const dialogs = document.querySelectorAll('dialog[open]');
                dialogs.forEach(d => {
                    try { d.close(); } catch(e) {}
                });
                return dialogs.length;
            });
            if (closedCount > 0) {
                logToFile(`ОЧИСТКА: Закрыто ${closedCount} диалоговых окон через JS.`);
            }
            await this.page.waitForTimeout(500);
            await this.page.keyboard.press('Escape');
            await this.page.waitForTimeout(500);
        } catch(e) {
            logToFile('Ошибка при очистке модалок: ' + e.message);
        }

        // Запоминаем текущий заголовок ДО начала поиска, чтобы убедиться в его смене
        const headerLocator = this.page.locator('.chat-header, .top-bar, .user-name, .header-title').first();
        let prevChatTitle = "";
        if (await headerLocator.count() > 0) {
            prevChatTitle = (await headerLocator.textContent() || "").trim();
            logToFile(`Текущий заголовок до поиска: "${prevChatTitle}"`);
        }

        await this.page.screenshot({ path: 'send_0_start.png' });
        
        try {
            // 1. ПоИСК КОНТАКТА
            const searchInputSelectors = [
                'input[placeholder*="Найти"]',
                'input[placeholder*="Поиск"]',
                '.search-input input',
                '.search-bar input',
                '[aria-label*="Найти"]'
            ];
            
            let searchInput = null;
            for (const selector of searchInputSelectors) {
                const element = this.page.locator(selector).first();
                if (await element.count() > 0) {
                    searchInput = element;
                    break;
                }
            }

            if (!searchInput) {
                this.isLoggedIn = false; // Force re-auth check next time
                throw new Error('ОШИБКА АВТОРИЗАЦИИ: Интерфейс MAX недоступен (возможно, требуется сканирование QR-кода). Проверьте last_qr.png');
            }

            let digitsOnly = phone.replace(/\D/g, '');
            const phoneSuffix = digitsOnly.slice(-4); 
            
            // Расширенные форматы для поиска
            const formats = [
                phone.startsWith('+') ? phone : '+' + phone, // +7...
                digitsOnly, // 7...
                digitsOnly.startsWith('7') ? '8' + digitsOnly.slice(1) : '8' + digitsOnly, // 8...
                digitsOnly.slice(-10), // 922... (без 7 или 8)
            ];
            
            const searchFormats = [...new Set(formats.filter(f => f))];
            let found = false;
            const ignoreList = ['Все', 'Сферум', 'Нове', 'Контакт', 'Звонки', 'Профиль', 'Чаты'];

            for (const searchStr of searchFormats) {
                logToFile(`Пробую формат поиска: ${searchStr}`);
                
                await searchInput.click({ force: true });
                await this.page.keyboard.press('Control+A');
                await this.page.keyboard.press('Backspace');
                await searchInput.type(searchStr, { delay: 30 });
                await this.page.waitForTimeout(4000); // Даем больше времени на подгрузку
                
                // 1. СНАЧАЛА ИЩЕМ В СПИСКЕ РЕЗУЛЬТАТОВ
                const resultSelectors = [
                    '.chat-list .chat-item', 
                    '.search-results .item', 
                    '.found-item', 
                    '.item',
                    '.contact-item'
                ];
                
                for (const selector of resultSelectors) {
                    const elements = this.page.locator(selector);
                    const count = await elements.count();
                    for (let i = 0; i < count; i++) {
                        const element = elements.nth(i);
                        if (await element.isVisible()) {
                            const content = (await element.textContent() || "").trim();
                            if (!content) continue;
                            
                            const isIgnored = ignoreList.some(ignore => content.includes(ignore));
                            if (isIgnored) continue;

                            const elementDigits = content.replace(/\D/g, '');
                            const nameMatch = name && content.toLowerCase().includes(name.toLowerCase());
                            const phoneMatch = elementDigits.includes(phoneSuffix);

                            if (phoneMatch || nameMatch) {
                                logToFile(`Результат подходит: "${content}" (Phone: ${phoneMatch}, Name: ${nameMatch}). Кликаю...`);
                                await element.click();
                                found = true;
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
                if (found) break;

                // 2. ПРОБУЕМ "Найти по номеру" в результатах поиска
                const findByNumberSelectors = [
                    'text="Найти по номеру"',
                    '.find-by-number',
                    '[aria-label*="номер"]',
                    '.search-results >> text="Найти по номерu"',
                    '.sidebar >> text="Найти по номеру"'
                ];
                
                let findByNumberBtn = null;
                for (const sel of findByNumberSelectors) {
                    const el = this.page.locator(sel).first();
                    if (await el.count() > 0 && await el.isVisible()) {
                        findByNumberBtn = el;
                        break;
                    }
                }

                if (findByNumberBtn) {
                    logToFile(`Найдена кнопка "Найти по номеру". Нажимаю и сразу перехожу к проверке чата...`);
                    await findByNumberBtn.click({ force: true });
                    found = true;
                }

                if (found) break; // Сразу выходим из цикла searchFormats, если нашли контакт напрямую или нажали "Найти по номеру"

                // 3. ПРОБУЕМ "Новый чат" (+) ЕСЛИ ВСЁ ЕЩЕ НЕ НАШЛИ
                const nothingFound = this.page.locator('text="Ничего не нашли", text="Ничего не найдено", .nothing-found').first();
                if (await nothingFound.isVisible() || !found) { 
                    logToFile(`Для "${searchStr}" чат не найден напрямую или через "Найти по номеру" в сайдбаре. Пробую через "+" ...`);
                    
                    const plusBtn = this.page.locator('.sidebar-header button, .chats-header button, .plus-button, [aria-label*="чат"], [aria-label*="сообщение"]').first();
                    if (await plusBtn.count() > 0) {
                        await plusBtn.click({ force: true });
                        await this.page.waitForTimeout(1000);
                        
                        // ПРОВЕРЯЕМ ПОПОВЕР МЕНЮ ПОСЛЕ "+"
                        const menuFindByNumber = this.page.locator('.popover >> text="Найти по номеру", .menu >> text="Найти по номеру", .dropdown >> text="Найти по номеру"').first();
                        if (await menuFindByNumber.count() > 0 && await menuFindByNumber.isVisible()) {
                            logToFile('Найдена иконка/текст "Найти по номеру" в меню после "+". Кликаю...');
                            await menuFindByNumber.click({ force: true });
                            await this.page.waitForTimeout(1500);
                        }

                        // В окне нового чата / поиска
                        const modalInput = this.page.locator('dialog[open] input, dialog[open] [placeholder*="имени"], dialog[open] [placeholder*="имя"], .modal input').first();
                        if (await modalInput.count() > 0 && await modalInput.isVisible()) {
                            logToFile('Найден инпут в модальном окне, кликаю для фокуса...');
                            await modalInput.click({ force: true });
                            await this.page.waitForTimeout(500);
                        }
                        
                        await this.page.keyboard.type(searchStr, { delay: 50 });
                        await this.page.waitForTimeout(2000); 
                        await this.page.keyboard.press('Enter');
                        await this.page.waitForTimeout(3000);
                        
                        const startChatBtn = this.page.locator('dialog[open] button:has-text("Написать"), dialog[open] button:has-text("Начать"), button:has-text("Начать")').first();
                        if (await startChatBtn.count() > 0 && await startChatBtn.isVisible()) {
                            logToFile('Найдена кнопка "Начать/Написать" в модалке. Кликаю...');
                            await startChatBtn.click({ force: true });
                            found = true;
                            break;
                        }
                        
                        const newResults = this.page.locator('dialog[open] .contact-item, dialog[open] .item');
                        const newResultsCount = await newResults.count();
                        if (newResultsCount > 0) {
                            logToFile(`Найдено ${newResultsCount} результатов в модальном окне. Ищу совпадение...`);
                            let selectedInModal = false;
                            
                            for (let j = 0; j < newResultsCount; j++) {
                                const res = newResults.nth(j);
                                const txt = (await res.textContent() || "").toLowerCase();
                                const hasPhone = txt.includes(phoneSuffix);
                                const hasName = name && txt.includes(name.toLowerCase());
                                
                                if (hasPhone || hasName) {
                                    logToFile(`Найдено совпадение в модалке: "${txt.trim()}". Кликаю...`);
                                    await res.click({ force: true });
                                    selectedInModal = true;
                                    break;
                                }
                            }
                            
                            if (!selectedInModal && newResultsCount > 0) {
                                logToFile('Совпадение не найдено, но есть результаты. Возможно, это единственный результат. Кликаю первый...');
                                await newResults.first().click({ force: true });
                                selectedInModal = true;
                            }

                            if (selectedInModal) {
                                await this.page.waitForTimeout(1000);
                                
                                // Шаг 2: Нажать "Далее" (Next)
                                const nextBtn = this.page.locator('dialog[open] button:has-text("Далее"), button:has-text("Далее"), dialog[open] button.next').first();
                                if (await nextBtn.count() > 0) {
                                    logToFile('Найдена кнопка "Далее" в модальном окне. Кликаю...');
                                    await nextBtn.click({ force: true });
                                    await this.page.waitForTimeout(2000);
                                }

                                // Шаг 3: Нажать "Написать" если появилось
                                const finalBtn = this.page.locator('dialog[open] button:has-text("Написать"), button:has-text("Написать")').first();
                                if (await finalBtn.count() > 0 && await finalBtn.isVisible()) {
                                    logToFile('Найдена финальная кнопка ("Написать") после "Далее". Кликаю...');
                                    await finalBtn.click({ force: true });
                                    await this.page.waitForTimeout(1000);
                                } else {
                                    logToFile('Финальная кнопка не найдена. Пробую кликнуть по первому результату в сайдбаре (куда он добавился)...');
                                    // Пытаемся кликнуть по первому найденному контакту в левой панели
                                    const firstSidebarItem = this.page.locator('.sidebar .contact-item, .sidebar .item, .search-results .item, .sidebar .chat-item, [class*="search"] [class*="item"], .chat-list > div').first();
                                    if (await firstSidebarItem.count() > 0 && await firstSidebarItem.isVisible()) {
                                        logToFile('Найден элемент в сайдбаре, кликаю...');
                                        try { await firstSidebarItem.click({ force: true, timeout: 2000 }); } catch(e) {}
                                    }
                                }

                                found = true;
                                break;
                            }
                        }

                        logToFile('В модальном окне ничего не выбрано или не найдено. Закрываем...');
                        await this.page.keyboard.press('Escape'); 
                        await this.page.waitForTimeout(1000);
                    }
                }
            }

            if (!found) {
                await this.page.screenshot({ path: 'not_found_error.png' });
                throw new Error(`Контакт ${phone} ${name ? '('+name+') ' : ''}не найден в MAX после всех попыток. Отмена отправки.`);
            }
            
            // ПРОВЕРКА ОТКРЫТИЯ ЧАТА
            logToFile(`Жду открытия чата (был: "${prevChatTitle}")`);
            await this.page.waitForTimeout(2000);
            
            let opened = false;
            for (let i = 0; i < 10; i++) {
                await this.page.waitForTimeout(1500);
                
                const header = await this.page.locator('.chat-header, .top-bar, .user-name, .header-title, h2, .title').first();
                const composer = await this.page.locator('.message-input, [contenteditable="true"], textarea, [placeholder*="Сообщение"], [placeholder*="Напишите"]').first();
                const url = this.page.url();
                
                let currentTitle = "";
                if (await header.count() > 0) {
                    currentTitle = (await header.textContent() || "").trim();
                }
                
                const composerVisible = await composer.count() > 0 && await composer.isVisible();
                const urlIndicatesChat = url.includes('/chat/') || url.includes('/messaging/') || url.match(/\/\d+$/);
                
                logToFile(`Попытка ${i+1}: Заголовок = "${currentTitle}", Инпут = ${composerVisible}, URL = ${url}`);

                if (composerVisible || urlIndicatesChat) {
                    logToFile('Чат успешно открыт (верификация по инпуту или URL)!');
                    await this.page.screenshot({ path: 'send_2_chat_opened.png' });
                    opened = true;
                    break;
                }
                
                if (i % 3 === 0 && i > 0) {
                    logToFile('Чат всё еще не открыт, пробую Enter и клик по самому первому результату в сайдбаре...');
                    await this.page.keyboard.press('Enter');
                    const firstSidebarItem = this.page.locator('.sidebar .contact-item, .sidebar .item, .search-results .item, .sidebar .chat-item, [class*="search"] [class*="item"], .chat-list > div').first();
                    if (await firstSidebarItem.count() > 0 && await firstSidebarItem.isVisible()) {
                        logToFile('Найден элемент в сайдбаре, кликаю...');
                        try { await firstSidebarItem.click({ force: true, timeout: 2000 }); } catch(e) {}
                    }
                    await this.page.screenshot({ path: `verification_retry_${i}.png` });
                }
            }
            
            await this.page.screenshot({ path: 'send_2_after_click_contact.png' });
            
            if (!opened) {
               throw new Error(`Не удалось переключить чат с "${prevChatTitle}" на контакт ${phone}`);
            }

            // 2. ВВОД ТЕКСТА
            const messageInputSelectors = [
                '.message-input',
                '[contenteditable="true"]',
                'textarea',
                '.composer-input',
                '[placeholder*="Сообщение"]',
                '[placeholder*="Напишите"]',
                'div[role="textbox"]'
            ];

            let messageInput = null;
            for (const selector of messageInputSelectors) {
                const element = this.page.locator(selector).first();
                if (await element.count() > 0 && await element.isVisible()) {
                    messageInput = element;
                    logToFile(`Поле сообщения найдено: ${selector}`);
                    break;
                }
            }

            if (!messageInput) {
                logToFile('ВНИМАНИЕ: Поле ввода не найдено селектором. Клик в область и ввод...');
                await this.page.mouse.click(800, 600); 
                await this.page.waitForTimeout(500);
                await this.page.keyboard.type(text);
                await this.page.keyboard.press('Enter');
            } else {
                await messageInput.click();
                await this.page.waitForTimeout(500);
                await this.page.keyboard.press('Control+A');
                await this.page.keyboard.press('Backspace');
                await messageInput.fill(text);
                await this.page.waitForTimeout(1000);
                
                const sendBtnSelectors = [
                    'button[aria-label*="Отправить"]',
                    'button[aria-label*="Send"]',
                    '.send-button',
                    '.btn-send',
                    'button.send',
                    '.message-input-buttons button.send',
                    '.message-input-wrapper + button'
                ];
                
                let sent = false;
                for (const sel of sendBtnSelectors) {
                    const btn = this.page.locator(sel).first();
                    if (await btn.count() > 0 && await btn.isVisible()) {
                        logToFile(`Найдена кнопка отправки: ${sel}. Кликаю...`);
                        await btn.click();
                        sent = true;
                        break;
                    }
                }
                
                logToFile('Кнопка отправки не найдена. Жму Enter...');
                await this.page.keyboard.press('Enter');
            }
            
            // Добавляем в глобальный список недавно отправленных для эхо-подавления по тексту
            this.recentlySentMessages.set(text, Date.now());
            
            await this.page.waitForTimeout(3000);
            await this.page.screenshot({ path: 'send_3_final.png' });

            const lastMsg = await this.page.locator('.message-item, .chat-bubble, .message, .bubble').last();
            if (await lastMsg.count() > 0) {
                const txt = await lastMsg.textContent();
                logToFile(`Факт в чате: "${txt.trim().substring(0, 40).replace(/\n/g, ' ')}..."`);
            }
            
            logToFile(`Завершено для ${phone}`);
        } catch (e) {
            logToFile(`Ошибка при отправке: ${e.message}`);
            await this.page.screenshot({ path: 'send_error.png' });
            throw e;
        } finally {
            this.isSendingMessage = false;
        }
    }
}

module.exports = { 
    maxBrowser: new MaxBrowser(),
    logToFile
};

