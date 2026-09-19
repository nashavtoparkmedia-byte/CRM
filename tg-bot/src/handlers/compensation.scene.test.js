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
            const refusal = !fake.selectedPark ? 'park_not_selected'
                : fake.selectedPark !== fake.provenPark ? 'selected_park_profile_unproven'
                    : null;
            switch (action) {
                case 'compensation_section': {
                    if (refusal) return { available: false, reason: refusal, applications: [] };
                    if (fake.catalogueStatus === 'disabled') return { available: false, reason: 'catalogue_disabled', applications: [] };
                    const query = payload.search || null;
                    const matches = query
                        ? fake.orders.filter((candidate) => candidate.shortOrderId === query
                            || String(Math.floor(candidate.amountKopecks / 100)) === query
                            || candidate.localTime === query)
                        : [];
                    return {
                        available: true,
                        scopeKey: fake.scopeKey(),
                        monthKey: '2026-09',
                        remainingBudgetKopecks: 500_000,
                        catalogueStatus: fake.catalogueStatus,
                        todayKey: TODAY,
                        orders: fake.orders,
                        search: query ? { query, kind: 'number', truncated: false, externalOrderIds: matches.map((m) => m.externalOrderId) } : null,
                        applications: [],
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

const open = (harness) => harness.text('💰 Компенсация наличных');
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

    assert.deepEqual(crm.calls.map((call) => call.action), ['compensation_section']);
    const payload = crm.calls[0].payload;
    assert.equal(payload.telegramId, '777001');
    assert.equal(payload.providerAccountId, '424242');
    assert.equal(payload.connectionId, 'telegram-connection-1');
    assert.equal('parkId' in payload || 'selectedExternalParkId' in payload, false);

    const message = harness.last();
    assert.match(message.text, /Остаток бюджета на 2026-09: 5000 ₽/);
    assert.match(message.text, /Сегодня:/);
    const labels = harness.buttons().map((button) => button.text);
    assert.deepEqual(labels.slice(0, 3), ['15:42 — 680 ₽', '12:18 — 430 ₽', '09:51 — 790 ₽']);
    assert.deepEqual(labels.slice(3), ['Более ранние заказы', 'Найти заказ', '🔄 Обновить', 'Отмена']);
    assert.equal(harness.buttons()[0].callback_data, orderData(O1));
});

test('asks for a park first and opens park selection', async () => {
    crm.selectedPark = null;
    const harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /Сначала выберите парк/);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_park'));

    await harness.tap('comp_park');
    assert.deepEqual(harness.parkSelectEntries, [777001]);
});

test('refuses a selected park the proven profile is not in, offering to switch', async () => {
    crm.selectedPark = 'park-b';
    const harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /пока недоступна для вашего подтверждённого профиля/);
    assert.ok(harness.buttons().some((button) => button.callback_data === 'comp_park'));
    assert.equal(crm.of('compensation_order_check').length, 0);
});

test('tells a park without a catalogue apart from an empty list, and shows partial and stale hints', async () => {
    crm.catalogueStatus = 'disabled';
    let harness = createBot();
    await open(harness);
    assert.match(harness.last().text, /компенсация наличных пока не подключена/);

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
    assert.equal(crm.of('compensation_section').length, 3);
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
    await open(harness);
    assert.match(harness.last().text, /Не удалось подтвердить привязку этого чата/);
});
