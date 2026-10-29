'use strict';

/**
 * Behaviour of the "💰 Компенсация наличных" scene, driven through Telegraf
 * with the Telegram API and the CRM replaced by in-process fakes. No network,
 * no Telegram token and no Yandex: the fake CRM answers the four compensation
 * actions the way the CRM's rules do, and records every call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CRM_TELEGRAM_CONNECTION_ID = 'telegram-connection-1';

// The scene reaches the CRM only through crmAction; install the fake there
// before the scene is loaded.
const crm = createFakeCrm();
const crmActionPath = require.resolve('../services/crmAction');
require.cache[crmActionPath] = {
    id: crmActionPath,
    filename: crmActionPath,
    loaded: true,
    exports: { callCRM: (action, payload) => crm.call(action, payload) },
};

const { Telegraf, Telegram, Scenes, session } = require('telegraf');
const { compensationScene, compensationStaleCallback } = require('./compensation');

// Telegraf builds a fresh Telegram client for every update, so the API is
// replaced on the class. Each harness has its own token and its own record of
// what was sent; nothing leaves the process.
const sentByToken = new Map();
Telegram.prototype.callApi = async function callApi(method, payload) {
    const sent = sentByToken.get(this.token);
    if (!sent) throw new Error(`no harness for this bot token (${method})`);
    sent.push({ method, payload });
    if (method === 'sendMessage') {
        return { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
    }
    return true;
};
let nextHarness = 1;

const SCOPE_A = 'aaaaaaaaaaaa';
const SCOPE_B = 'bbbbbbbbbbbb';
const TODAY = '2026-09-18';

function order(id, dayKey, localTime, amountKopecks, extra = {}) {
    return {
        externalOrderId: id,
        shortOrderId: extra.shortOrderId || null,
        amountKopecks,
        endedAt: `${dayKey}T00:00:00.000Z`,
        dayKey,
        localTime,
        localDate: `${dayKey.slice(8, 10)}.${dayKey.slice(5, 7)}`,
        claimed: extra.claimed === true,
    };
}

const O1 = order('1'.repeat(32), TODAY, '15:42', 68_000, { shortOrderId: '4821' });
const O2 = order('2'.repeat(32), TODAY, '12:18', 43_000, { shortOrderId: '4821' });
const O3 = order('3'.repeat(32), TODAY, '09:51', 79_000, { shortOrderId: '5100' });
const EARLIER = Array.from({ length: 10 }, (_, index) => order(
    `e${String(index).padStart(31, '0')}`, `2026-09-${String(17 - index).padStart(2, '0')}`, '10:00', 50_000,
));
crm.reset();

function createFakeCrm() {
    const fake = {
        calls: [],
        reset() {
            fake.calls = [];
            fake.selectedPark = 'park-a';
            fake.provenPark = 'park-a';
            fake.catalogueStatus = 'ready';
            fake.orders = [O1, O2, O3, ...EARLIER];
            fake.checkStates = [];
            fake.submitAnswers = [];
            fake.refreshStatus = 'scheduled';
            fake.failures = {};
            fake.delays = {};
            // On demand: how the CRM answers each picked day (default: the provider answered).
            fake.dayKinds = {};
            // A refusal the section answers with before anything else (identity, eligibility).
            fake.reason = null;
            // A refusal every later action answers with, as when the person changed after the list was shown.
            fake.laterRefusal = null;
            fake.applications = [];
            fake.remainingBudgetKopecks = 500_000;
        },
        scopeKey() {
            return fake.selectedPark === 'park-b' ? SCOPE_B : SCOPE_A;
        },
        async call(action, payload) {
            fake.calls.push({ action, payload });
            if (fake.delays[action]) await new Promise((resolve) => setTimeout(resolve, fake.delays[action]));
            const failure = fake.failures[action] && fake.failures[action].shift();
            if (failure) {
                const error = new Error(`CRM action ${action} failed with status ${failure}`);
                error.status = failure;
                throw error;
            }
            const parkRefusal = !fake.selectedPark ? 'park_not_selected'
                : fake.selectedPark !== fake.provenPark ? 'selected_park_profile_unproven'
                    : null;
            const refusal = action === 'compensation_section' ? parkRefusal : fake.laterRefusal || parkRefusal;
            switch (action) {
                case 'compensation_section': {
                    if (fake.reason) return { available: false, reason: fake.reason, applications: fake.applications };
                    if (refusal) return { available: false, reason: refusal, applications: [] };
                    if (fake.catalogueStatus === 'disabled') return { available: false, reason: 'catalogue_disabled', applications: [] };
                    const query = payload.search || null;
                    if (fake.catalogueStatus === 'on_demand' && query && /^\d{4}-\d{2}-\d{2}$/.test(query)) {
                        const kind = fake.dayKinds[query] || 'date';
                        const dayOrders = kind === 'date' ? fake.orders.filter((candidate) => candidate.dayKey === query) : [];
                        return {
                            available: true,
                            scopeKey: fake.scopeKey(),
                            monthKey: '2026-09',
                            remainingBudgetKopecks: fake.remainingBudgetKopecks,
                            catalogueStatus: 'on_demand',
                            todayKey: TODAY,
                            orders: fake.orders,
                            search: { query, kind, truncated: false, externalOrderIds: dayOrders.map((m) => m.externalOrderId) },
                            applications: fake.applications,
                        };
                    }
                    const matches = query
                        ? fake.orders.filter((candidate) => candidate.shortOrderId === query
                            || String(Math.floor(candidate.amountKopecks / 100)) === query
                            || candidate.localTime === query)
                        : [];
                    return {
                        available: true,
                        scopeKey: fake.scopeKey(),
                        monthKey: '2026-09',
                        remainingBudgetKopecks: fake.remainingBudgetKopecks,
                        catalogueStatus: fake.catalogueStatus,
                        todayKey: TODAY,
                        orders: fake.orders,
                        search: query ? { query, kind: 'number', truncated: false, externalOrderIds: matches.map((m) => m.externalOrderId) } : null,
                        applications: fake.applications,
                    };
                }
                case 'compensation_order_check': {
                    if (refusal) return { state: 'refused', refusal, order: null };
                    if (payload.scopeKey !== fake.scopeKey()) return { state: 'stale_context', refusal: null, order: null };
                    const found = fake.orders.find((candidate) => candidate.externalOrderId === payload.externalOrderId);
                    if (!found) return { state: 'gone', refusal: null, order: null };
                    return { state: fake.checkStates.shift() || 'fresh', refusal: null, order: found };
                }
                case 'compensation_refresh':
                    return refusal ? { status: 'refused', refusal } : { status: fake.refreshStatus, refusal: null };
                case 'compensation_submit': {
                    if (refusal) return { submitted: false, refusal };
                    if (payload.scopeKey !== fake.scopeKey()) return { submitted: false, refusal: 'stale_context' };
                    return fake.submitAnswers.shift() || { submitted: true, applicationId: 'app-1', amountKopecks: payload.claimedRubles * 100, status: 'created' };
                }
                default:
                    throw new Error(`unexpected action ${action}`);
            }
        },
        of(action) {
            return fake.calls.filter((call) => call.action === action);
        },
    };
    return fake;
}

const USER = { id: 777001, is_bot: false, first_name: 'Driver' };
const CHAT = { id: 777001, type: 'private' };
let nextUpdateId = 1;

function createBot() {
    const token = `123456:TEST-TOKEN-NOT-REAL-${nextHarness++}`;
    // A closed loopback port, should anything bypass the replaced client.
    const bot = new Telegraf(token, { telegram: { apiRoot: 'http://127.0.0.1:9' } });
    bot.botInfo = { id: 424242, is_bot: true, first_name: 'Test', username: 'test_bot' };
    const sent = [];
    sentByToken.set(token, sent);
    const parkSelectEntries = [];
    const parkSelect = new Scenes.BaseScene('parkSelect');
    parkSelect.enter((ctx) => { parkSelectEntries.push(ctx.from.id); });
    const stage = new Scenes.Stage([compensationScene, parkSelect]);
    bot.use(session());
    bot.use(stage.middleware());
    bot.action(/^comp_/, compensationStaleCallback);
    bot.hears('💰 Компенсация наличных', (ctx) => ctx.scene.enter('compensation'));

    const messages = () => sent.filter((entry) => entry.method === 'sendMessage').map((entry) => entry.payload);
    const last = () => messages()[messages().length - 1];
    const buttons = (message = last()) => (message.reply_markup && message.reply_markup.inline_keyboard
        ? message.reply_markup.inline_keyboard.flat()
        : []);
    return {
        bot,
        parkSelectEntries,
        messages,
        last,
        buttons,
        text: (text) => bot.handleUpdate({
            update_id: nextUpdateId++,
            message: { message_id: nextUpdateId, date: 0, chat: CHAT, from: USER, text },
        }),
        tap: (data) => bot.handleUpdate({
            update_id: nextUpdateId++,
            callback_query: {
                id: String(nextUpdateId),
                from: USER,
                chat_instance: 'chat-instance',
                data,
                message: { message_id: 1, date: 0, chat: CHAT, from: { id: 424242, is_bot: true, first_name: 'Test' }, text: 'list' },
            },
        }),
        photo: (fileId) => bot.handleUpdate({
            update_id: nextUpdateId++,
            message: {
                message_id: nextUpdateId,
                date: 0,
                chat: CHAT,
                from: USER,
                photo: [
                    { file_id: `${fileId}-small`, file_unique_id: 'small', width: 90, height: 90 },
                    { file_id: fileId, file_unique_id: 'large', width: 1280, height: 960 },
                ],
            },
        }),
    };
}

// Pressing the menu entry shows the banner; «💰 Подать заявку» opens the claim.
const press = (harness) => harness.text('💰 Компенсация наличных');
async function open(harness) {
    await press(harness);
    await harness.tap('comp_apply');
}
const orderData = (candidate, scopeKey = SCOPE_A) => `comp_o:${scopeKey}:${candidate.externalOrderId}`;

async function reachAttach(harness) {
    await open(harness);
    await harness.tap(orderData(O1));
    await harness.tap('comp_support_yes');
    await harness.text('300');
}

test.beforeEach(() => crm.reset());

test('opens on today from the local list, newest first, asking the CRM nothing else', async () => {
    const harness = createBot();
    await open(harness);

    // Once for the banner, once more when the driver applies; neither searches.
    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section', 'compensation_section']);
    assert.deepEqual(crm.calls.map((call) => call.payload.search), [undefined, undefined]);
    const payload = crm.calls[0].payload;
    assert.equal(payload.telegramId, '777001');
    assert.equal(payload.providerAccountId, '424242');
    assert.equal(payload.connectionId, 'telegram-connection-1');
    assert.equal('parkId' in payload || 'selectedExternalParkId' in payload, false);

    const message = harness.last();
    assert.doesNotMatch(message.text, /Остаток|бюджет|5000/);
    assert.match(message.text, /Сегодня:/);
    const labels = harness.buttons().map((button) => button.text);
    assert.deepEqual(labels.slice(0, 3), ['15:42 — 680 ₽', '12:18 — 430 ₽', '09:51 — 790 ₽']);
    assert.deepEqual(labels.slice(3), ['Более ранние заказы', 'Найти заказ', '🔄 Обновить', 'Отмена']);
    assert.equal(harness.buttons()[0].callback_data, orderData(O1));
});

test('asks for a park first and opens park selection', async () => {
    crm.selectedPark = null;
    const harness = createBot();
    await press(harness);
    assert.match(harness.last().text, /Сейчас подать заявку нельзя\.\nПричина: в боте не выбран парк\.\nЧто делать: выберите парк кнопкой ниже\./);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_park'));

    await harness.tap('comp_park');
    assert.deepEqual(harness.parkSelectEntries, [777001]);
});

test('refuses a selected park the proven profile is not in, offering to switch', async () => {
    crm.selectedPark = 'park-b';
    const harness = createBot();
    await press(harness);
    assert.match(harness.last().text, /Причина: в выбранном парке не найден ваш подтверждённый профиль водителя\./);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_park'));
    assert.equal(crm.of('compensation_order_check').length, 0);
});

test('tells a park without a catalogue apart from an empty list, and shows partial and stale hints', async () => {
    crm.catalogueStatus = 'disabled';
    let harness = createBot();
    await press(harness);
    assert.equal(harness.last().text, TECHNICAL_FAILURE_TEXT);
    assert.deepEqual(harness.buttons(), []);

    crm.reset();
    crm.orders = [];
    harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /Сегодня завершённых заказов за наличные пока нет, более ранних тоже/);

    for (const [status, hint] of [['partial', /догружается/], ['stale', /давно не обновлялся/]]) {
        crm.reset();
        crm.catalogueStatus = status;
        harness = createBot();
        await open(harness);
        assert.match(harness.last().text, hint);
        assert.equal(harness.buttons()[0].callback_data, orderData(O1));
    }
});

test('pages earlier orders, reading the list afresh for every page', async () => {
    const harness = createBot();
    await open(harness);
    await harness.tap('comp_earlier:0');
    let labels = harness.buttons().map((button) => button.text);
    assert.equal(labels.filter((label) => label.endsWith('500 ₽')).length, 8);
    assert.equal(labels[0], '17.09 10:00 — 500 ₽');
    assert.ok(labels.includes('Старее ›'));

    await harness.tap('comp_earlier:1');
    labels = harness.buttons().map((button) => button.text);
    assert.equal(labels.filter((label) => label.endsWith('500 ₽')).length, 2);
    assert.ok(labels.includes('‹ Новее'));
    assert.equal(crm.of('compensation_section').length, 4);
});

test('offers every search candidate and never chooses one', async () => {
    const harness = createBot();
    await open(harness);
    await harness.tap('comp_find');
    await harness.text('4821');

    const search = crm.of('compensation_section').pop();
    assert.equal(search.payload.search, '4821');
    assert.match(harness.last().text, /Найдено заказов: 2/);
    const offered = harness.buttons().filter((button) => button.callback_data.startsWith('comp_o:'));
    assert.deepEqual(offered.map((button) => button.callback_data), [orderData(O1), orderData(O2)]);

    await harness.tap('comp_find');
    await harness.text('5100');
    assert.match(harness.last().text, /Найдено заказов: 1/);
    assert.equal(harness.buttons().filter((button) => button.callback_data.startsWith('comp_o:')).length, 1);
    assert.equal(crm.of('compensation_order_check').length, 0);
});

test('refresh only schedules and answers at once, without polling', async () => {
    const harness = createBot();
    await open(harness);
    const before = crm.calls.length;
    await harness.tap('comp_refresh');
    assert.deepEqual(crm.calls.slice(before).map((call) => call.action), ['compensation_refresh']);
    assert.match(harness.last().text, /Обновляем список из Яндекса/);

    crm.refreshStatus = 'recent';
    await harness.tap('comp_refresh');
    assert.match(harness.last().text, /только что обновлялся/);
});

test('walks a fresh order through support, amount and screenshot to one submit', async () => {
    const harness = createBot();
    await reachAttach(harness);

    const check = crm.of('compensation_order_check')[0].payload;
    assert.deepEqual(
        { externalOrderId: check.externalOrderId, scopeKey: check.scopeKey, retry: check.retry },
        { externalOrderId: O1.externalOrderId, scopeKey: SCOPE_A, retry: false },
    );

    await harness.photo('support-reply');
    const submits = crm.of('compensation_submit');
    assert.equal(submits.length, 1);
    const payload = submits[0].payload;
    assert.equal(payload.externalOrderId, O1.externalOrderId);
    assert.equal(payload.scopeKey, SCOPE_A);
    assert.equal(payload.claimedRubles, 300);
    assert.equal(payload.supportConfirmed, true);
    assert.equal(payload.attachmentFileId, 'support-reply');
    assert.equal(payload.attachmentKind, 'photo');
    assert.match(payload.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.match(harness.last().text, /Заявка отправлена/);
});

test('takes a request above the 500 ₽ cap, sends it unchanged and shows what the CRM will pay', async () => {
    const harness = createBot();
    await open(harness);
    await harness.tap(orderData(O1));
    await harness.tap('comp_support_yes');
    assert.match(harness.last().text, /К выплате — не больше 500 ₽ и не больше стоимости заказа/);
    await harness.text('800');
    assert.match(harness.last().text, /Пришлите ответ поддержки Яндекса/);
    // The CRM, not the bot, applies min(request, order, 500 ₽).
    crm.submitAnswers.push({ submitted: true, applicationId: 'app-cap', amountKopecks: 50000, status: 'created' });
    await harness.photo('support-reply');
    assert.equal(crm.of('compensation_submit')[0].payload.claimedRubles, 800);
    assert.match(harness.last().text, /Заявка отправлена\. К выплате 500 ₽/);
});

test('stops only an absurd amount locally, at the CRM request bound', async () => {
    const harness = createBot();
    await open(harness);
    await harness.tap(orderData(O1));
    await harness.tap('comp_support_yes');
    await harness.text('100001');
    assert.match(harness.last().text, /Слишком большая сумма/);
    await harness.text('100000');
    assert.match(harness.last().text, /Пришлите ответ поддержки Яндекса/);
    assert.equal(crm.of('compensation_submit').length, 0);
});

test('lets the driver carry on while Yandex is asked about an older order', async () => {
    crm.checkStates = ['checking'];
    const harness = createBot();
    await open(harness);
    await harness.tap(orderData(O1));
    assert.match(harness.last().text, /Проверяем этот заказ в Яндексе/);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_support_yes'));
});

test('drops a duplicate tap on the same order while its check is pending', async () => {
    crm.delays.compensation_order_check = 30;
    const harness = createBot();
    await open(harness);
    await Promise.all([harness.tap(orderData(O1)), harness.tap(orderData(O1))]);
    assert.equal(crm.of('compensation_order_check').length, 1);
});

test('sends one submit for two screenshots at once', async () => {
    crm.delays.compensation_submit = 30;
    const harness = createBot();
    await reachAttach(harness);
    await Promise.all([harness.photo('first'), harness.photo('second')]);
    assert.equal(crm.of('compensation_submit').length, 1);
});

test('requires the screenshot and submits nothing without it', async () => {
    const harness = createBot();
    await reachAttach(harness);
    await harness.text('вот ответ поддержки');
    assert.match(harness.last().text, /Нужен ответ поддержки Яндекса/);
    assert.equal(crm.of('compensation_submit').length, 0);
});

test('keeps the claim and its key while Yandex is still checking, and resubmits on request', async () => {
    crm.submitAnswers = [{ submitted: false, refusal: 'order_confirmation_pending' }];
    const harness = createBot();
    await reachAttach(harness);
    await harness.photo('support-reply');
    assert.match(harness.last().text, /Ещё проверяем заказ/);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_resubmit'));

    await harness.tap('comp_resubmit');
    const [first, second] = crm.of('compensation_submit').map((call) => call.payload);
    assert.equal(second.idempotencyKey, first.idempotencyKey);
    assert.equal(second.attachmentFileId, 'support-reply');
    assert.match(harness.last().text, /Заявка отправлена/);
});

test('retries a lost submit answer with the same key', async () => {
    crm.failures.compensation_submit = [504];
    const harness = createBot();
    await reachAttach(harness);
    await harness.photo('support-reply');
    assert.match(harness.last().text, /попробуйте отправить ещё раз/);
    await harness.tap('comp_resubmit');
    const keys = crm.of('compensation_submit').map((call) => call.payload.idempotencyKey);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
});

test('fails closed when the active park changed between the list and the tap', async () => {
    const harness = createBot();
    await open(harness);
    crm.selectedPark = 'park-b';
    await harness.tap(orderData(O1));
    assert.match(harness.last().text, /пока недоступна для вашего подтверждённого профиля/);

    // The link now proves a profile in park B: the park A button is stale.
    crm.reset();
    const again = createBot();
    await open(again);
    crm.selectedPark = 'park-b';
    crm.provenPark = 'park-b';
    await again.tap(orderData(O1, SCOPE_A));
    assert.match(again.last().text, /Список устарел: сменился парк или профиль/);
    await again.tap('comp_support_yes');
    assert.equal(crm.of('compensation_submit').length, 0);
});

test('answers a list button pressed after switching park through park selection as stale', async () => {
    const harness = createBot();
    await open(harness);
    const data = harness.buttons()[0].callback_data;
    await harness.tap('comp_park');
    const checks = crm.of('compensation_order_check').length;
    await harness.tap(data);
    assert.match(harness.last().text, /Этот список устарел/);
    assert.equal(crm.of('compensation_order_check').length, checks);
});

test('answers an old button after a bot restart as stale and calls nothing', async () => {
    const before = createBot();
    await open(before);
    const data = before.buttons()[0].callback_data;

    const restarted = createBot();
    const calls = crm.calls.length;
    await restarted.tap(data);
    await restarted.tap('comp_support_yes');
    assert.equal(crm.calls.length, calls);
    assert.match(restarted.last().text, /Этот список устарел/);
});

test('treats a pilot-era button inside an open scene as stale', async () => {
    const harness = createBot();
    await open(harness);
    await harness.tap(`comp_order:${O1.externalOrderId}`);
    assert.match(harness.last().text, /Этот список устарел/);
    assert.equal(crm.of('compensation_order_check').length, 0);
});

test('tells the driver an order left the catalogue between choosing and submitting', async () => {
    crm.submitAnswers = [{ submitted: false, refusal: 'order_not_in_catalogue' }];
    const harness = createBot();
    await reachAttach(harness);
    await harness.photo('support-reply');
    assert.match(harness.last().text, /больше недоступен для компенсации/);
});

test('offers a retry after a failed provider check, and sends it as a retry', async () => {
    crm.checkStates = ['check_failed'];
    const harness = createBot();
    await open(harness);
    await harness.tap(orderData(O1));
    assert.match(harness.last().text, /Не получилось проверить заказ в Яндексе/);
    assert.ok(!harness.buttons().some((button) => button.callback_data === 'comp_support_yes'));

    await harness.tap('comp_retry_check');
    const checks = crm.of('compensation_order_check').map((call) => call.payload.retry);
    assert.deepEqual(checks, [false, true]);
});

test('stops at a definitive not-confirmed answer', async () => {
    crm.checkStates = ['not_confirmed'];
    const harness = createBot();
    await open(harness);
    await harness.tap(orderData(O1));
    assert.match(harness.last().text, /Яндекс не подтвердил этот заказ/);
    assert.ok(!harness.buttons().some((button) => button.callback_data === 'comp_support_yes'));
});

test('answers refused chat authority as a binding problem', async () => {
    crm.failures.compensation_section = [409];
    const harness = createBot();
    await press(harness);
    const text = harness.last().text;
    assert.match(text, /Причина: бот не смог подтвердить связь вашего Telegram с профилем водителя YOKO\./);
    assert.match(text, /Номер телефона повторно отправлять не нужно/);
    assert.doesNotMatch(text, /поделитесь номером/);
    assert.doesNotMatch(text, /не соответствует действующим условиям/);
});

test('answers refused chat authority later in the claim with the short sentence', async () => {
    const harness = createBot();
    await open(harness);
    crm.failures.compensation_order_check = [409];
    await harness.tap(orderData(O1));
    assert.match(harness.last().text, /Не удалось подтвердить привязку этого чата/);
});

// ── On demand: the driver picks a day ──────────────────────────────────────

test('on demand opens on a date picker of the first month, asking the CRM nothing else', async () => {
    crm.reset();
    crm.catalogueStatus = 'on_demand';
    const harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /Выберите дату, когда завершился заказ/);
    const data = harness.buttons().map((button) => button.callback_data);
    assert.deepEqual(data.slice(0, 7), ['2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12'].map((day) => `comp_day:${day}`));
    assert.ok(data.includes('comp_day_other'));
    assert.ok(!data.includes('comp_refresh'));
    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section', 'compensation_section']);
    assert.deepEqual(crm.calls.map((call) => call.payload.search), [undefined, undefined]);
});

test('a picked day lists only that day, and an order from it goes through the usual claim', async () => {
    crm.reset();
    crm.catalogueStatus = 'on_demand';
    const harness = createBot();
    await open(harness);
    await harness.tap(`comp_day:${TODAY}`);
    assert.equal(crm.of('compensation_section').pop().payload.search, TODAY);
    assert.match(harness.last().text, /Заказы за 18\.09/);
    const offered = harness.buttons().map((button) => button.callback_data).filter((data) => data.startsWith('comp_o:'));
    assert.deepEqual(offered, [O1, O2, O3].map((candidate) => orderData(candidate)));
    await harness.tap(orderData(O1));
    await harness.tap('comp_support_yes');
    await harness.text('500');
    await harness.photo('support-reply');
    const submit = crm.of('compensation_submit').pop();
    assert.equal(submit.payload.externalOrderId, O1.externalOrderId);
    assert.equal(submit.payload.claimedRubles, 500);
});

test('tells no orders, still checking, Yandex unavailable and a day out of reach apart', async () => {
    crm.reset();
    crm.catalogueStatus = 'on_demand';
    crm.orders = [];
    crm.dayKinds = { '2026-09-16': 'date_checking', '2026-09-15': 'date_unavailable', '2026-09-01': 'date_not_allowed' };
    const harness = createBot();
    await open(harness);

    await harness.tap('comp_day:2026-09-17');
    assert.equal(harness.last().text, 'За выбранную дату подходящих наличных заказов не найдено. Выберите другую дату.');

    await harness.tap('comp_day:2026-09-16');
    assert.match(harness.last().text, /Проверяем заказы за 16\.09/);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_day:2026-09-16'));

    await harness.tap('comp_day:2026-09-15');
    assert.match(harness.last().text, /Яндекс сейчас не отвечает/);
    assert.doesNotMatch(harness.last().text, /не найден/);

    await harness.tap('comp_day:2026-09-01');
    assert.equal(harness.last().text, 'За выбранную дату компенсация недоступна. Выберите другую дату, если у вас есть неоплаченные наличные заказы за подходящий период.');
});

test('another date is typed as DD.MM and checked before the CRM is asked', async () => {
    crm.reset();
    crm.catalogueStatus = 'on_demand';
    const harness = createBot();
    await open(harness);
    await harness.tap('comp_day_other');
    const before = crm.calls.length;
    await harness.text('31.02');
    assert.match(harness.last().text, /Такой даты нет/);
    await harness.text('завтра');
    assert.match(harness.last().text, /Введите дату как ДД\.ММ/);
    assert.equal(crm.calls.length, before);
    await harness.text('5.09');
    assert.equal(crm.of('compensation_section').pop().payload.search, '2026-09-05');
});

test('the usual park list stays as it was outside on-demand mode', async () => {
    crm.reset();
    const harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /Сегодня:/);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_refresh'));
    assert.ok(!harness.buttons().some((button) => String(button.callback_data).startsWith('comp_day')));
});


// ── Entry: the banner, and who may apply ───────────────────────────────────

const ELIGIBLE_LINES = [
    '💰 Компенсация наличных',
    'Пассажир не оплатил поездку наличными?',
    'Если Яндекс отказал в компенсации, YOKO может компенсировать вам до 500 ₽ за заказ.',
    '1. Обратитесь в поддержку Яндекса по неоплаченному заказу и попросите компенсировать его стоимость.',
    '5. Дождитесь решения менеджера. После одобрения мы перечислим компенсацию.',
    '• До 500 ₽ за один заказ.',
    '• Не более одного компенсированного заказа в день.',
    '• Для подачи заявки необходим отказ Яндекса.',
    '• Выплата производится вручную после одобрения заявки.',
];
const RESTRICTED_LINES = [
    'В YOKO действует программа компенсации неоплаченных наличных заказов до 500 ₽.',
    'Сейчас программа доступна новым водителям, подключившимся к YOKO в качестве парковых самозанятых, за заказы первого месяца работы.',
    '4. Отправьте заявку и дождитесь решения менеджера.',
    'Сейчас подать заявку нельзя.',
];
// Owner-approved sentences. Each programme condition names itself.
const CONDITION_TEXT = {
    not_self_employed: 'По данным парка, вы подключены не как парковый самозанятый. Программа компенсации доступна только парковым самозанятым. Если данные неверны, напишите менеджеру.',
    outside_first_calendar_month: 'Компенсация доступна за заказы первого календарного месяца после подключения к парку, а заявки по ним принимаются до 72 часов после окончания этого месяца. Срок подачи заявок для вашего периода завершился. Если дата подключения указана неверно, напишите менеджеру.',
};
const NOT_LINKED_TEXT = 'Чтобы воспользоваться компенсацией, привяжите Telegram к своему профилю водителя: откройте «🚘 Мой автомобиль» и поделитесь номером телефона. Если автоматически привязать не получится, напишите менеджеру — он привяжет профиль вручную.';
const PERSON_UNCONFIRMED_TEXT = 'Подать заявку пока нельзя: профиль для выплаты ещё не подтверждён в CRM. Напишите менеджеру — после подтверждения откройте этот раздел снова.';
const TECHNICAL_FAILURE_TEXT = 'Не удалось проверить данные. Попробуйте ещё раз чуть позже 🔄';
// A sentence that says itself why applying is closed replaces the banner's own line.
const SENTENCE_LINES = RESTRICTED_LINES.filter((line) => line !== 'Сейчас подать заявку нельзя.');

function assertLines(text, lines) {
    for (const line of lines) assert.ok(text.split('\n').includes(line), `missing line: ${line}`);
}

test('an admitted driver sees the programme banner, and the date picker only after «Подать заявку»', async () => {
    crm.catalogueStatus = 'on_demand';
    const harness = createBot();
    await press(harness);

    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section']);
    assert.equal(crm.calls[0].payload.search, undefined);
    assertLines(harness.last().text, ELIGIBLE_LINES);
    assert.doesNotMatch(harness.last().text, /Сейчас подать заявку нельзя|Остаток бюджета/);
    assert.deepEqual(harness.buttons().map((button) => [button.text, button.callback_data]), [['💰 Подать заявку', 'comp_apply']]);

    await harness.tap('comp_apply');
    assert.match(harness.last().text, /Выберите дату, когда завершился заказ/);
    assert.deepEqual(crm.calls.map((call) => call.payload.search), [undefined, undefined]);

    await harness.tap(`comp_day:${TODAY}`);
    assert.deepEqual(crm.calls.map((call) => call.payload.search), [undefined, undefined, TODAY]);
});

test('the banner lists the driver\'s applications with their status', async () => {
    crm.applications = [{ shortOrderId: '4821', amountKopecks: 30_000, status: 'awaiting_payment', rejectionReason: null }];
    const harness = createBot();
    await press(harness);
    assert.match(harness.last().text, /Ваши заявки:\n• Заказ №4821: 300 ₽ — одобрена, ждёт выплаты$/);
    assert.equal(harness.buttons()[0].callback_data, 'comp_apply');
});

test('a confirmed driver outside the programme conditions sees the restricted banner and cannot apply', async () => {
    for (const reason of ['not_self_employed', 'outside_first_calendar_month']) {
        crm.reset();
        crm.reason = reason;
        const harness = createBot();
        await press(harness);
        const text = harness.last().text;
        assertLines(text, SENTENCE_LINES);
        assert.ok(text.endsWith(`\n\n${CONDITION_TEXT[reason]}`), text);
        assert.doesNotMatch(text, /Если Яндекс отказал в компенсации|не соответствует действующим условиям|Причина:/);
        assert.deepEqual(harness.buttons(), []);

        // The scene is closed: an apply tap is answered as stale and asks the CRM nothing.
        await harness.tap('comp_apply');
        assert.match(harness.last().text, /Этот список устарел/);
        assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section']);
    }
});

test('an unknown Telegram user is asked to link and never reaches a claim', async () => {
    crm.reason = 'identity_not_proven';
    const harness = createBot();
    await press(harness);
    const text = harness.last().text;
    assertLines(text, SENTENCE_LINES);
    assert.ok(text.endsWith(`\n\n${NOT_LINKED_TEXT}`), text);
    assert.doesNotMatch(text, /не соответствует действующим условиям/);

    await harness.tap('comp_apply');
    await harness.tap(orderData(O1));
    await harness.tap('comp_support_yes');
    await harness.photo('support-reply');
    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section']);
});

test('a linked driver the programme admits, with no person for the money yet, sees the programme but no apply button', async () => {
    crm.reason = 'cash_person_unconfirmed';
    const harness = createBot();
    await press(harness);
    const text = harness.last().text;
    assertLines(text, ELIGIBLE_LINES);
    assert.ok(text.endsWith(`\n\n${PERSON_UNCONFIRMED_TEXT}`), text);
    assert.doesNotMatch(text, /поделитесь номером|Мой автомобиль|не соответствует действующим условиям|Причина:/);
    assert.deepEqual(harness.buttons(), []);

    // The scene is closed: an apply tap is answered as stale and asks the CRM nothing.
    await harness.tap('comp_apply');
    assert.match(harness.last().text, /Этот список устарел/);
    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section']);
});

test('a CRM that still decides the person first sends the person sentence, never "not linked"', async () => {
    crm.reason = 'identity_needs_review';
    const harness = createBot();
    await press(harness);
    const text = harness.last().text;
    assertLines(text, SENTENCE_LINES);
    assert.ok(text.endsWith(`\n\n${PERSON_UNCONFIRMED_TEXT}`), text);
    assert.doesNotMatch(text, /поделитесь номером|не соответствует действующим условиям/);
    // The fake CRM throws on any action it does not know, so this is every call.
    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section']);
});

test('a claim the CRM refuses for want of a person is told so, and nothing is sent again', async () => {
    crm.laterRefusal = 'cash_person_unconfirmed';
    const harness = createBot();
    await open(harness);
    await harness.tap(orderData(O1));
    assert.equal(harness.last().text, PERSON_UNCONFIRMED_TEXT);
    assert.equal(crm.of('compensation_submit').length, 0);
});

test('a CRM that cannot answer is not a verdict on the driver', async () => {
    for (const setup of [
        () => { crm.failures.compensation_section = [503]; },
        () => { crm.failures.compensation_section = [504]; },
        () => { crm.reason = 'identity_busy'; },
        // A fact the CRM could not state and its own park setup are CRM problems,
        // never a verdict on the driver and never shown as one.
        () => { crm.reason = 'self_employment_unknown'; },
        () => { crm.reason = 'hire_date_unknown'; },
        () => { crm.reason = 'catalogue_disabled'; },
        () => { crm.reason = 'a_refusal_this_bot_does_not_know'; },
    ]) {
        crm.reset();
        setup();
        const harness = createBot();
        await press(harness);
        const text = harness.last().text;
        assert.equal(text, TECHNICAL_FAILURE_TEXT, crm.reason);
        assert.doesNotMatch(text, /Сейчас подать заявку нельзя|не соответствует|поделитесь номером/);
        assert.deepEqual(harness.buttons(), []);
    }
});

test('a month with no budget open shows no zero, and the claim gets the CRM\'s own refusal', async () => {
    crm.catalogueStatus = 'on_demand';
    crm.remainingBudgetKopecks = 0;
    crm.submitAnswers = [{ submitted: false, refusal: 'period_missing' }];
    const harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /^💰 Компенсация наличных\n\nВыберите дату, когда завершился заказ:$/);
    assert.doesNotMatch(harness.last().text, /Остаток бюджета|0 ₽/);
    await harness.tap(`comp_day:${TODAY}`);
    await harness.tap(orderData(O1));
    await harness.tap('comp_support_yes');
    await harness.text('300');
    await harness.photo('support-reply');
    assert.equal(crm.of('compensation_submit').length, 1);
    assert.equal(harness.last().text, 'Приём заявок за этот месяц закрыт. Напишите менеджеру.');
});

test('the internal budget is never shown, whatever is left', async () => {
    for (const status of ['on_demand', 'ready']) {
        crm.reset();
        crm.catalogueStatus = status;
        crm.remainingBudgetKopecks = 437_500;
        const harness = createBot();
        await open(harness);
        await harness.tap(status === 'on_demand' ? `comp_day:${TODAY}` : 'comp_earlier:0');
        for (const message of harness.messages()) {
            assert.doesNotMatch(message.text, /Остаток|бюджет|4375/);
        }
    }
});

const OWN_APPLICATION = { shortOrderId: '4821', amountKopecks: 30_000, status: 'submitted', rejectionReason: null };

test('applications sent with an unproven or unreliable identity never reach the chat', async () => {
    for (const setup of [
        () => { crm.reason = 'identity_not_proven'; },
        () => { crm.reason = 'identity_needs_review'; },
        () => { crm.reason = 'cash_person_unconfirmed'; },
        () => { crm.reason = 'identity_busy'; },
        () => { crm.reason = 'a_refusal_this_bot_does_not_know'; },
    ]) {
        crm.reset();
        setup();
        crm.applications = [OWN_APPLICATION];
        const harness = createBot();
        await press(harness);
        const text = harness.last().text;
        assert.equal(crm.of('compensation_section')[0].payload.search, undefined);
        assert.doesNotMatch(text, /Ваши заявки|4821|300 ₽|на рассмотрении/, `${crm.reason}: ${text}`);
    }
});

test('a confirmed driver the section refuses still sees their own applications', async () => {
    for (const reason of ['not_self_employed', 'outside_first_calendar_month', 'park_not_selected']) {
        crm.reset();
        crm.reason = reason;
        crm.applications = [OWN_APPLICATION];
        const harness = createBot();
        await press(harness);
        assert.match(harness.last().text, /\n\nВаши заявки:\n• Заказ №4821: 300 ₽ — на рассмотрении$/, reason);
    }
});
