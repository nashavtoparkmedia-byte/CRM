'use strict';

/**
 * The referral entry and link capture in the driver bot.
 *
 * One flag, BOT_REFERRAL_ENTRY_ENABLED, releases both; only the exact string
 * "true" does. A captured link is answered with one sentence whatever the
 * CRM found, and the token reaches the CRM only: never the log, never the
 * action record. The CRM decides who may invite; the bot only shows what it
 * was told.
 *
 * Everything runs in process with the CRM call, the logger and the services
 * replaced before the handlers load.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');
const TOKEN = 'r_AbCdEfGhIjKlMnOpQrStUv';

function stub(specifier, exports) {
    const resolved = require.resolve(specifier, { paths: [path.join(SRC, 'handlers')] });
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/** Loads fresh handlers with the flag set to `value` and the CRM answering with `answer`. */
function load(value, answer) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC + path.sep)) delete require.cache[key];
    }
    if (value === undefined) delete process.env.BOT_REFERRAL_ENTRY_ENABLED;
    else process.env.BOT_REFERRAL_ENTRY_ENABLED = value;
    const calls = [];
    const logged = [];
    const record = (...args) => logged.push(args);
    stub('../services/crmAction', {
        callCRM: async (action, payload) => {
            calls.push({ action, payload });
            if (answer instanceof Error) throw answer;
            return typeof answer === 'function' ? answer(action, payload) : answer;
        },
    });
    stub('../utils/logger', { info: record, warn: record, error: record, debug: record });
    stub('@prisma/client', { PrismaClient: class { constructor() { this.bot = { findUnique: async () => null }; this.user = { findFirst: async () => null }; } } });
    stub('../services/userService', { registerUser: async () => {}, logAction: async (...args) => record('logAction', ...args), resetUserFlow: async () => {} });
    stub('../services/sheets', { upsertUserRow: async () => {} });
    stub('../public-bot-maintenance', { ensureBotMappingV1: async () => null });
    const referral = require('../handlers/referral');
    const start = require('../handlers/start');
    return { referral, start, calls, logged };
}

function ctx(overrides = {}) {
    const replies = [];
    return {
        from: { id: 777001, username: 'driver' },
        chat: { id: 777001, type: 'private' },
        botInfo: { id: 555, username: 'yoko_park_bot' },
        session: {},
        scene: { leave: async () => {} },
        replies,
        reply: async (body, extra) => { replies.push({ body, extra }); return { message_id: 1 }; },
        ...overrides,
    };
}

test('only a token-shaped payload is a referral payload', () => {
    const { referral } = load('true', {});
    assert.equal(referral.isReferralPayload(TOKEN), true);
    for (const other of ['', 'r_short', `${TOKEN}x`, 'promo2026', 'r_AbCdEfGhIjKlMnOpQrSt!v', undefined, null, 42]) {
        assert.equal(referral.isReferralPayload(other), false, `${other} must not be a referral payload`);
    }
});

test('the entry exists only while the flag is exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', ' true', '1', 'yes']) {
        assert.deepEqual(load(value, {}).referral.referralEntryButtons(), [], `value ${JSON.stringify(value)}`);
    }
    assert.deepEqual(load('true', {}).referral.referralEntryButtons(), ['🎁 Пригласить водителя']);
});

test('an opened link is captured with one sentence for every outcome, and the token reaches only the CRM', async () => {
    for (const answer of [{ status: 'recorded' }, new Error('down')]) {
        const { start, calls, logged } = load('true', answer);
        const c = ctx({ startPayload: TOKEN });
        await start.handleStart(c);
        const capture = calls.find((call) => call.action === 'referral_capture');
        assert.ok(capture, 'the capture was sent to the CRM');
        assert.equal(capture.payload.token, TOKEN);
        assert.equal(capture.payload.telegramId, '777001');
        assert.equal(c.replies[0].body, 'Приглашение получено. Подключение ещё не подтверждено: после подключения к парку бот проверит его автоматически.');
        assert.ok(!JSON.stringify(logged).includes(TOKEN.slice(2)), 'the token reached the log or the action record');
    }
});

test('nothing is captured while the entry is unreleased or the payload is not a token', async () => {
    for (const [value, payload] of [[undefined, TOKEN], ['false', TOKEN], ['true', 'promo2026'], ['true', undefined]]) {
        const { start, calls } = load(value, { status: 'recorded' });
        await start.handleStart(ctx({ startPayload: payload }));
        assert.equal(calls.filter((call) => call.action === 'referral_capture').length, 0, `${value} / ${payload}`);
    }
});

test('the inviter gets a personal link and only counts, never anything about an invitee', async () => {
    const { referral, calls } = load('true', {
        status: 'issued',
        token: TOKEN,
        invitations: { captured: 2, qualified: 1 },
        accessSince: '2026-11-05T06:00:00.000Z',
    });
    const c = ctx();
    await referral.showReferral(c);
    assert.equal(calls[0].action, 'referral_issue');
    const body = c.replies[0].body;
    assert.match(body, /https:\/\/t\.me\/yoko_park_bot\?start=r_AbCdEfGhIjKlMnOpQrStUv/);
    assert.match(body, /бессрочно, с 05\.11\.2026/);
    assert.match(body, /перешли по ссылке: 2 · засчитаны: 1/);
});

test('a refusal says why, and nothing is asked while unreleased', async () => {
    const cases = [
        [{ status: 'refused', reason: 'cash_person_unconfirmed' }, /привяжите Telegram/],
        [{ status: 'refused', reason: 'disabled' }, /пока недоступен/],
        [{ status: 'refused', reason: 'identity_busy' }, /Попробуйте ещё раз/],
        [new Error('down'), /Попробуйте ещё раз/],
        [{ status: 'issued', token: 'not-a-token' }, /Попробуйте ещё раз/],
    ];
    for (const [answer, expected] of cases) {
        const { referral } = load('true', answer);
        const c = ctx();
        await referral.showReferral(c);
        assert.match(c.replies[0].body, expected);
    }
    const { referral, calls } = load(undefined, {});
    const c = ctx();
    await referral.showReferral(c);
    assert.equal(calls.length, 0);
    assert.match(c.replies[0].body, /пока недоступен/);
});

test('the status text shows no access and no invitations plainly', () => {
    const { referral } = load('true', {});
    assert.equal(referral.statusText({}, null), 'Доступ по приглашению: ещё нет.\nПо вашим ссылкам пока никто не переходил.');
});
