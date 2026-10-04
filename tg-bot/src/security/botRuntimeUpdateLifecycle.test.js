'use strict';

/**
 * Inbound update lifecycle: single-flight dedupe and proven bot identity.
 *
 * Two live defects motivate these tests.
 *
 * The dedupe map recorded an update_id *before* running its handler chain and
 * never removed it, so a failed update was remembered as seen. Telegram's retry
 * of that update was then answered 200 without being processed and the message
 * was silently dropped. The state model here is NEW -> IN_FLIGHT -> COMPLETED,
 * where COMPLETED is reached only on success and a failure removes the
 * reservation so the retry can execute for real.
 *
 * Separately, Telegraf 4.16.3 fills `botInfo` lazily inside `handleUpdate` and
 * memoises the call in `botInfoCall`, which it never clears. Webhook mode never
 * calls `launch()`, so the first update triggered a getMe; when that getMe hit
 * the flaky egress to api.telegram.org the rejected promise stayed cached and
 * every later update rejected with it until the process restarted. Identity is
 * now established up front and updates are refused until it is proven.
 *
 * Everything here runs against fakes and a loopback HTTP server. Nothing
 * production is touched and no network egress is attempted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createBotRuntime } = require('../services/botRuntime');
const { CRM_FORWARD_OUTCOME, isRetryableStatus } = require('../services/crmIntegration');

const BOT_ID = 8447212640;
const BOT_USERNAME = 'yoko_driver_bot';

const silentLogger = { info() {}, warn() {}, error() {} };

function baseEnv(overrides = {}) {
    return {
        BOT_UPDATE_MODE: 'webhook',
        TELEGRAM_WEBHOOK_URL: 'https://example.test/api/telegram/webhook',
        BOT_TOKEN: '123456789:TEST-TOKEN-VALUE-NOT-A-REAL-SECRET',
        ...overrides,
    };
}

/** A minimal stand-in for a Telegraf instance. */
function fakeBot({ onUpdate, getMe } = {}) {
    const calls = { getMe: 0, updates: [] };
    const bot = {
        botInfo: undefined,
        calls,
        telegram: {
            async getMe() {
                calls.getMe += 1;
                if (getMe) return getMe(calls.getMe);
                return { id: BOT_ID, username: BOT_USERNAME };
            },
            async getWebhookInfo() {
                return { url: 'https://example.test/api/telegram/webhook', allowed_updates: ['message', 'callback_query'] };
            },
            async setWebhook() { return true; },
        },
        async handleUpdate(update) {
            calls.updates.push(update?.update_id);
            if (onUpdate) return onUpdate(update);
            return undefined;
        },
    };
    return bot;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function readyRuntime(bot, envOverrides = {}) {
    const runtime = createBotRuntime({ env: baseEnv(envOverrides), logger: silentLogger });
    runtime.attach(bot);
    await runtime.ensureBotIdentity();
    return runtime;
}

// ── A. a failed attempt must not be recorded as completed ────────────────────

test('A. a failed update rejects and is not recorded as completed', async () => {
    const bot = fakeBot({ onUpdate: async () => { throw new Error('handler exploded'); } });
    const runtime = await readyRuntime(bot);

    await assert.rejects(
        () => runtime.handleUpdate({ update_id: 5001 }),
        /handler exploded/,
        'the caller must see the failure so the webhook can answer non-2xx'
    );

    assert.equal(runtime.completedUpdateCount, 0, 'a failure must record nothing');
    assert.equal(runtime.inFlightUpdateCount, 0, 'the in-flight reservation must be released');
});

test('A. a synchronous throw from the handler also clears the reservation', async () => {
    const bot = fakeBot();
    bot.handleUpdate = function throwsSynchronously() {
        throw new Error('synchronous boom');
    };
    const runtime = await readyRuntime(bot);

    await assert.rejects(() => runtime.handleUpdate({ update_id: 5002 }), /synchronous boom/);
    assert.equal(runtime.inFlightUpdateCount, 0);
    assert.equal(runtime.completedUpdateCount, 0);
});

test('A. an async rejection clears the reservation', async () => {
    const bot = fakeBot({ onUpdate: () => Promise.reject(new Error('async boom')) });
    const runtime = await readyRuntime(bot);

    await assert.rejects(() => runtime.handleUpdate({ update_id: 5003 }), /async boom/);
    assert.equal(runtime.inFlightUpdateCount, 0);
    assert.equal(runtime.completedUpdateCount, 0);
});

// ── B. the retry of a failed update really executes ──────────────────────────

test('B. after a failure the same update_id executes on retry, exactly once', async () => {
    let attempt = 0;
    const sideEffects = [];
    const bot = fakeBot({
        onUpdate: async (update) => {
            attempt += 1;
            if (attempt === 1) throw new Error('transient handler failure');
            sideEffects.push(update.update_id);
        },
    });
    const runtime = await readyRuntime(bot);

    await assert.rejects(() => runtime.handleUpdate({ update_id: 6001 }));
    assert.deepEqual(sideEffects, [], 'the first attempt produced no side effect');

    const second = await runtime.handleUpdate({ update_id: 6001 });
    assert.deepEqual(second, { duplicate: false }, 'the retry is a real execution, not a duplicate');
    assert.deepEqual(sideEffects, [6001], 'the side effect happened exactly once');
    assert.deepEqual(bot.calls.updates, [6001, 6001], 'the handler chain ran twice: fail then succeed');
    assert.equal(runtime.completedUpdateCount, 1);
    assert.equal(runtime.inFlightUpdateCount, 0);
});

// ── C. replay of a completed update is side-effect free ──────────────────────

test('C. replaying a completed update returns idempotent success with no second side effect', async () => {
    const sideEffects = [];
    const bot = fakeBot({ onUpdate: async (update) => { sideEffects.push(update.update_id); } });
    const runtime = await readyRuntime(bot);

    const first = await runtime.handleUpdate({ update_id: 7001 });
    assert.deepEqual(first, { duplicate: false });

    const replay = await runtime.handleUpdate({ update_id: 7001 });
    assert.deepEqual(replay, { duplicate: true }, 'a completed replay reports duplicate success');

    assert.deepEqual(sideEffects, [7001], 'no second side effect');
    assert.deepEqual(bot.calls.updates, [7001], 'the handler chain ran once');
});

// ── D. single-flight for simultaneous deliveries ─────────────────────────────

test('D. two simultaneous deliveries of one update_id produce a single owner execution', async () => {
    const gate = deferred();
    const sideEffects = [];
    const bot = fakeBot({
        onUpdate: async (update) => {
            sideEffects.push(update.update_id);
            await gate.promise;
        },
    });
    const runtime = await readyRuntime(bot);

    const first = runtime.handleUpdate({ update_id: 8001 });
    const second = runtime.handleUpdate({ update_id: 8001 });

    assert.equal(runtime.inFlightUpdateCount, 1, 'exactly one reservation for the id');
    assert.deepEqual(sideEffects, [8001], 'the duplicate did not start its own execution');

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    assert.deepEqual(a, { duplicate: false });
    assert.deepEqual(b, { duplicate: false }, 'the waiter receives the owner terminal outcome');
    assert.deepEqual(sideEffects, [8001], 'still exactly one side-effect execution');
    assert.deepEqual(bot.calls.updates, [8001], 'the handler chain ran once');
    assert.equal(runtime.inFlightUpdateCount, 0);
    assert.equal(runtime.completedUpdateCount, 1);
});

test('D. a concurrent waiter receives the owner failure, and neither is completed', async () => {
    const gate = deferred();
    const bot = fakeBot({ onUpdate: async () => { await gate.promise; } });
    const runtime = await readyRuntime(bot);

    const first = runtime.handleUpdate({ update_id: 8002 });
    const second = runtime.handleUpdate({ update_id: 8002 });
    assert.equal(runtime.inFlightUpdateCount, 1);

    gate.reject(new Error('owner failed'));

    await assert.rejects(() => first, /owner failed/);
    await assert.rejects(() => second, /owner failed/, 'the waiter sees the same terminal outcome');
    assert.equal(runtime.completedUpdateCount, 0, 'a failed owner completes nothing');
    assert.equal(runtime.inFlightUpdateCount, 0, 'the reservation is released for the retry');
});

// ── E. identity is established once and never lazily re-fetched ──────────────

test('E. identity is proven once and later egress failures do not trigger another getMe', async () => {
    let failAfterFirst = false;
    const bot = fakeBot({
        getMe: (callCount) => {
            if (failAfterFirst && callCount > 1) {
                const error = new Error('read ECONNRESET');
                error.code = 'ECONNRESET';
                throw error;
            }
            return { id: BOT_ID, username: BOT_USERNAME };
        },
    });
    const runtime = await readyRuntime(bot);

    assert.equal(bot.calls.getMe, 1, 'identity cost exactly one getMe');
    assert.deepEqual(bot.botInfo, { id: BOT_ID, username: BOT_USERNAME },
        'Telegraf botInfo is populated, so its lazy path is short-circuited');
    assert.equal(runtime.identityEstablished(), true);

    failAfterFirst = true;
    const result = await runtime.handleUpdate({ update_id: 9001 });

    assert.deepEqual(result, { duplicate: false }, 'the update succeeds despite a broken egress');
    assert.equal(bot.calls.getMe, 1, 'no second getMe was attempted');

    await runtime.ensureBotIdentity();
    assert.equal(bot.calls.getMe, 1, 'a later identity check reuses the cached value');
});

test('E. updates are refused while identity is unproven, and nothing is recorded', async () => {
    const bot = fakeBot({
        getMe: () => { throw new Error('read ECONNRESET'); },
    });
    const runtime = createBotRuntime({ env: baseEnv(), logger: silentLogger });
    runtime.attach(bot);

    await assert.rejects(() => runtime.ensureBotIdentity(), /ECONNRESET/);
    assert.equal(runtime.identityEstablished(), false);

    await assert.rejects(
        () => runtime.handleUpdate({ update_id: 9002 }),
        /TELEGRAM_BOT_IDENTITY_UNPROVEN/,
        'fail closed rather than letting Telegraf take the lazy path'
    );
    assert.deepEqual(bot.calls.updates, [], 'the handler chain never ran');
    assert.equal(runtime.completedUpdateCount, 0);
    assert.equal(runtime.inFlightUpdateCount, 0);
});

test('E. a partial getMe result is rejected rather than fabricated into an identity', async () => {
    const bot = fakeBot({ getMe: () => ({ id: BOT_ID }) });
    const runtime = createBotRuntime({ env: baseEnv(), logger: silentLogger });
    runtime.attach(bot);

    await assert.rejects(() => runtime.ensureBotIdentity(), /TELEGRAM_BOT_IDENTITY_UNPROVEN/);
    assert.equal(runtime.identityEstablished(), false);
    assert.equal(bot.botInfo, undefined, 'a partial identity is never assigned to Telegraf');
});

// ── updates without an update_id still run, without poisoning the map ────────

test('an update with no update_id runs and reserves nothing', async () => {
    const sideEffects = [];
    const bot = fakeBot({ onUpdate: async (update) => { sideEffects.push(update); } });
    const runtime = await readyRuntime(bot);

    const result = await runtime.handleUpdate({ message: { text: 'no id' } });
    assert.deepEqual(result, { duplicate: false });
    assert.equal(sideEffects.length, 1);
    assert.equal(runtime.completedUpdateCount, 0, 'nothing to deduplicate on, so nothing recorded');
    assert.equal(runtime.inFlightUpdateCount, 0);
});

// ── the webhook route maps these outcomes to the right HTTP status ───────────

test('the webhook route answers 500 on failure and 200 on success/replay', async () => {
    const singleton = require('../services/botRuntime');
    const express = require('express');

    const originalHandle = singleton.handleUpdate;
    const originalValidate = singleton.validateWebhookSecret;

    let behaviour = 'fail';
    singleton.validateWebhookSecret = () => true;
    singleton.handleUpdate = async () => {
        if (behaviour === 'fail') throw new Error('handler failed');
        if (behaviour === 'duplicate') return { duplicate: true };
        return { duplicate: false };
    };

    const app = express();
    app.use(express.json());
    app.use('/api/telegram', require('../routes/telegram'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const post = (body) => new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/telegram/webhook',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'x-telegram-bot-api-secret-token': 'anything',
            },
        }, (response) => {
            let raw = '';
            response.on('data', (chunk) => { raw += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: raw }));
        });
        request.on('error', reject);
        request.write(payload);
        request.end();
    });

    try {
        const failed = await post({ update_id: 1 });
        assert.equal(failed.status, 500, 'a failed update must not be acknowledged');

        behaviour = 'ok';
        const ok = await post({ update_id: 2 });
        assert.equal(ok.status, 200);
        assert.match(ok.body, /"duplicate":false/);

        behaviour = 'duplicate';
        const replay = await post({ update_id: 2 });
        assert.equal(replay.status, 200, 'a completed replay is idempotent success');
        assert.match(replay.body, /"duplicate":true/);
    } finally {
        singleton.handleUpdate = originalHandle;
        singleton.validateWebhookSecret = originalValidate;
        await new Promise((resolve) => server.close(resolve));
    }
});

// ── F. the signed CRM forwarding contract is unchanged ───────────────────────

test('F. CRM forward retry classification is unchanged: 5xx/transport retry, 4xx terminal', () => {
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(502), true);
    assert.equal(isRetryableStatus(503), true);
    for (const status of [400, 401, 403, 404, 409, 422]) {
        assert.equal(isRetryableStatus(status), false, `${status} must be terminal`);
    }
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(undefined), false, 'a non-numeric status is never retryable');

    assert.deepEqual(
        Object.keys(CRM_FORWARD_OUTCOME).sort(),
        ['RETRY_EXHAUSTED_TRANSIENT', 'SKIPPED', 'SUCCESS', 'TERMINAL_4XX', 'UNBOUND'],
        'the bounded outcome set is unchanged'
    );
});
