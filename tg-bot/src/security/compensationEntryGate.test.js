'use strict';

/**
 * The compensation entry release gate.
 *
 * Deploying the bot must not release the cash-compensation pilot. One flag,
 * BOT_COMPENSATION_ENTRY_ENABLED, decides whether the entry exists, and only the
 * exact string "true" releases it — anything else, including a value someone
 * mistyped, keeps it hidden. The flag answers that one question and nothing else:
 * eligibility, park authority, catalogue state, budget and order freshness stay
 * with the CRM, which refuses independently.
 *
 * Three places have to agree, so all three are proven here:
 *
 *   keyboard      the main menu does not offer the label while hidden
 *   menu action   the label typed or pressed from a stale keyboard is refused
 *                 locally — no scene, no CRM call
 *   interruption  the label belongs to bot.js's pre-Stage reset list only while
 *                 released, so a stale press cannot throw a driver out of an
 *                 unrelated survey, car or order flow
 *
 * Everything runs in process. Prisma, the sheets and user services, the logger
 * and the bot-mapping maintenance are replaced before start.js is loaded, and
 * http/https are replaced so that any outbound attempt is both blocked and
 * counted — which is how "does not call Gravity" is proven rather than asserted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const SRC = path.resolve(__dirname, '..');
const LABEL = '💰 Компенсация наличных';

// ── outbound guard ────────────────────────────────────────────────────────────
// Nothing in this file may reach the network. Every attempt is counted so a test
// can assert on the count, and then refused.
let outbound = [];
const refuse = (name) => function refused(...args) {
    outbound.push({ via: name, target: typeof args[0] === 'string' ? args[0] : (args[0] && args[0].hostname) || null });
    throw new Error(`outbound ${name} is blocked in this test`);
};
http.request = refuse('http.request');
https.request = refuse('https.request');
http.get = refuse('http.get');
https.get = refuse('https.get');

// ── module loading ────────────────────────────────────────────────────────────
function stub(specifier, exports) {
    const resolved = require.resolve(specifier);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/** Loads a fresh start.js with the flag set to `value` (undefined = unset). */
function loadStart(value) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC + path.sep)) delete require.cache[key];
    }
    if (value === undefined) delete process.env.BOT_COMPENSATION_ENTRY_ENABLED;
    else process.env.BOT_COMPENSATION_ENTRY_ENABLED = value;

    stub('@prisma/client', {
        PrismaClient: class {
            constructor() {
                this.bot = { findUnique: async () => null };
                this.user = { findFirst: async () => null };
            }
        },
    });
    stub('../services/userService', { resetUserFlow: async () => {} });
    stub('../services/sheets', {});
    stub('../utils/logger', { info() {}, warn() {}, error() {}, debug() {} });
    stub('../public-bot-maintenance', { ensureBotMappingV1: async () => {} });

    outbound = [];
    return require('../handlers/start');
}

/** A ctx that records replies and whether a scene was entered. */
function makeCtx(text) {
    const ctx = {
        from: { id: 777001 },
        chat: { id: 777001, type: 'private' },
        message: text === undefined ? undefined : { text },
        session: {},
        entered: [],
        replies: [],
        scene: {
            enter: async (name) => { ctx.entered.push(name); },
            leave: async () => {},
        },
        reply: async (body, extra) => { ctx.replies.push({ body, extra }); return { message_id: 1 }; },
    };
    return ctx;
}

async function keyboardRows(value) {
    const start = loadStart(value);
    const ctx = makeCtx();
    await start.showMainMenu(ctx);
    const menu = ctx.replies.find((entry) => entry.extra && entry.extra.reply_markup);
    assert.ok(menu, 'the main menu reply carried no reply_markup');
    return menu.extra.reply_markup.keyboard.map((row) => [...row]);
}

const flat = (rows) => rows.flat();

// ── A–E: only the exact string "true" releases the entry ──────────────────────

test('A. flag absent: the entry is not offered', async () => {
    assert.ok(!flat(await keyboardRows(undefined)).includes(LABEL));
});

test('B. flag empty: the entry is not offered', async () => {
    assert.ok(!flat(await keyboardRows('')).includes(LABEL));
});

test('C. flag false: the entry is not offered', async () => {
    assert.ok(!flat(await keyboardRows('false')).includes(LABEL));
});

test('D. malformed or near-miss values are not "true"', async () => {
    for (const value of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'enabled', 'да', '0', 'null']) {
        const rows = flat(await keyboardRows(value));
        assert.ok(!rows.includes(LABEL), `value ${JSON.stringify(value)} must not release the entry`);
    }
});

test('E. exactly "true" offers the entry, in its agreed place', async () => {
    const rows = await keyboardRows('true');
    const flattened = flat(rows);
    assert.ok(flattened.includes(LABEL));
    // Its own row, and after the support/chat row as designed.
    const own = rows.findIndex((row) => row.length === 1 && row[0] === LABEL);
    assert.ok(own >= 0, 'the entry should occupy its own row');
    const chat = rows.findIndex((row) => row.includes('💬 Чат водителей'));
    assert.ok(chat >= 0 && own > chat, 'the entry should follow the chat/support row');
});

// ── F/G: the menu action ─────────────────────────────────────────────────────

test('F. released: the label enters the compensation scene', async () => {
    const start = loadStart('true');
    const ctx = makeCtx(LABEL);
    await start.handleMenuAction(ctx, {}, {});
    assert.deepEqual(ctx.entered, ['compensation']);
});

test('G. hidden: a stale keyboard press is refused locally, with no CRM call', async () => {
    const start = loadStart(undefined);
    const ctx = makeCtx(LABEL);
    await start.handleMenuAction(ctx, {}, {});
    // No scene.
    assert.deepEqual(ctx.entered, []);
    // One bounded sentence, and it does not pretend the feature is coming back
    // "temporarily" the way an outage message would.
    assert.equal(ctx.replies.length, 1);
    assert.equal(typeof ctx.replies[0].body, 'string');
    assert.ok(ctx.replies[0].body.length <= 120, 'the refusal should stay one short sentence');
    assert.ok(ctx.replies[0].body.includes('недоступен'));
    // And nothing was asked of Gravity.
    assert.deepEqual(outbound, [], 'a hidden entry must not reach the CRM');
});

test('G2. hidden: the same refusal for a hand-typed label', async () => {
    const start = loadStart('false');
    const ctx = makeCtx(LABEL);
    await start.handleMessage(ctx, {}, {});
    assert.deepEqual(ctx.entered, []);
    assert.deepEqual(outbound, []);
});

// ── H/I: the interruption list bot.js checks before Stage ─────────────────────

test('H. hidden: the label is not an interruption button, so no flow is reset', async () => {
    const start = loadStart(undefined);
    assert.deepEqual(start.compensationEntryButtons(), []);
    // bot.js builds its pre-Stage reset list from this, so an empty list means a
    // stale press falls through to the normal handlers instead of resetting the
    // survey, car or order scene the driver is in.
    assert.ok(!start.compensationEntryButtons().includes(LABEL));
});

test('I. released: the label is an interruption button again, unchanged', async () => {
    const start = loadStart('true');
    assert.deepEqual(start.compensationEntryButtons(), [LABEL]);
});

test('I2. bot.js takes its interruption entry only from that helper', () => {
    const source = fs.readFileSync(path.join(SRC, 'bot.js'), 'utf8');
    const list = source.slice(source.indexOf('const staticButtons = ['), source.indexOf('bot.use(async (ctx, next)'));
    assert.ok(list.includes('...startHandler.compensationEntryButtons()'),
        'bot.js must spread the gated helper into staticButtons');
    assert.ok(!list.includes(`'${LABEL}'`),
        'bot.js must not hold the compensation label unconditionally');
    // The unrelated interruption buttons stay exactly as they were.
    for (const other of ['🔙 Меню', '🛠 Поддержка', '📖 Новости', '🚖 Yandex Taxi Fun',
        '🚗 Подключиться', '🚘 Мой автомобиль', '🚖 Текущий заказ', '💳 Только безнал', '💵 Включить наличку']) {
        assert.ok(list.includes(`'${other}'`), `${other} must remain an interruption button`);
    }
});

// ── J: an old inline callback stays inert ─────────────────────────────────────

test('J. an old comp_* inline callback is answered as stale, not acted on', async () => {
    loadStart(undefined);
    const { compensationStaleCallback } = require('../handlers/compensation');
    const answered = [];
    const ctx = {
        from: { id: 777001 },
        chat: { id: 777001, type: 'private' },
        callbackQuery: { data: 'comp_o:aaaaaaaaaaaa:' + '1'.repeat(32) },
        scene: undefined,
        answerCbQuery: async (text) => { answered.push(text ?? null); },
        reply: async () => ({ message_id: 1 }),
        editMessageReplyMarkup: async () => true,
    };
    await compensationStaleCallback(ctx, async () => {});
    // It answered the tap and reached no CRM: the registration stays in place so
    // buttons from a keyboard sent before a recreate cannot do anything.
    assert.deepEqual(outbound, []);
});

// ── K/L: the gate owns nothing it should not ──────────────────────────────────

test('K. no eligibility, catalogue, budget or freshness rule enters tg-bot', () => {
    const forbidden = [
        'isSelfEmployed', 'is_selfemployed', 'yandexHireDate', 'hire_date',
        'firstCalendarMonth', 'first_calendar_month',
        'ORDER_CHECK_MAX_AGE_MS', 'SUBMISSION_MAX_AGE_MS', 'PILOT_FRESHNESS',
        'remainingBudgetKopecks', 'limitKopecks', 'budgetPeriod',
        'classifyCashOrderParkAuthority', 'pilotCatalogueStatus', 'cashOrderCatalogue',
    ];
    for (const file of ['config.js', 'bot.js', 'handlers/start.js']) {
        const source = fs.readFileSync(path.join(SRC, file), 'utf8');
        for (const token of forbidden) {
            assert.ok(!source.includes(token), `${file} must not contain ${token}`);
        }
    }
});

test('L. every other menu button, row and order is identical in both states', async () => {
    const hidden = await keyboardRows(undefined);
    const shown = await keyboardRows('true');
    const withoutEntry = shown.filter((row) => !(row.length === 1 && row[0] === LABEL));
    assert.deepEqual(withoutEntry, hidden,
        'releasing the entry must add one row and change nothing else');
});

test('L2. the menu action for unrelated buttons is untouched by the flag', async () => {
    for (const value of [undefined, 'true']) {
        const start = loadStart(value);
        const ctx = makeCtx('🛠 Поддержка');
        await start.handleMenuAction(ctx, {}, {});
        assert.equal(ctx.replies.length, 1, 'support should answer exactly once');
        assert.ok(String(ctx.replies[0].body).includes('Техподдержка'));
        assert.deepEqual(ctx.entered, []);
    }
});
