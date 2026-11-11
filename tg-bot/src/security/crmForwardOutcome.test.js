'use strict';

/**
 * Forwarding correctness for the CRM ingress.
 *
 * The incident showed the two defects proven here: a 401 was retried four times
 * as if it were transient, and the forward was fire-and-forget, so nothing ever
 * observed its outcome. These tests pin the classification and the terminal
 * result shape. They use a loopback server only; nothing production is touched.
 */

const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    CrmIntegrationService,
    CRM_FORWARD_OUTCOME,
    createFileCrmOutbox,
    crmOutboxDirectory,
    isDeferrableRefusal,
    isTerminalRefusal,
    isRetryableStatus,
    redeliveryDelayMs,
    redeliveryLimits,
} = require('../services/crmIntegration');
const logger = require('../utils/logger');
const { readFileSync } = require('node:fs');
const { resolve: resolvePath } = require('node:path');

const BOT_ACCOUNT = 8447212640;
const BOT_CONNECTION = 'driver-bot-primary';

function telegramUpdate(overrides = {}) {
    return {
        botInfo: { id: BOT_ACCOUNT },
        update: { update_id: overrides.updateId || 1001 },
        from: { id: 42, username: 'driver42', first_name: 'Driver' },
        message: {
            message_id: overrides.messageId || 2001,
            date: 1_764_672_000,
            text: overrides.text || 'hello',
            chat: { id: 42, type: 'private' },
        },
    };
}

/** A loopback CRM that answers with a scripted sequence of status codes. */
async function crmStub(statuses) {
    const received = [];
    let index = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({
                signature: req.headers['x-bot-signature'],
                payload: JSON.parse(body || '{}'),
            });
            const status = statuses[Math.min(index, statuses.length - 1)];
            index += 1;
            if (status === 'hang') return; // never answers: exercises the timeout arm
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const stub = {
        url: `http://127.0.0.1:${server.address().port}/api/webhook/telegram`,
        received,
        close: () => new Promise((resolve) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
    openStubs.add(stub);
    return stub;
}

// A failed assertion must never leave a loopback server holding the process.
const openStubs = new Set();
afterEach(async () => {
    for (const stub of openStubs) await stub.close();
    openStubs.clear();
});

function withEnv(url, extra = {}) {
    const previous = { ...process.env };
    process.env.CRM_WEBHOOK_URL = url;
    process.env.CRM_TELEGRAM_CONNECTION_ID = BOT_CONNECTION;
    process.env.BOT_CRM_SECRET = 'test-bot-crm-forward-secret-0123456789abcdef';
    Object.assign(process.env, extra);
    return () => {
        for (const key of Object.keys(process.env)) {
            if (!(key in previous)) delete process.env[key];
        }
        Object.assign(process.env, previous);
    };
}

test('classifies only transport and server faults as retryable', () => {
    for (const status of [500, 502, 503, 504]) {
        assert.equal(isRetryableStatus(status), true, `${status} must retry`);
    }
    for (const status of [400, 401, 403, 404, 409, 418, 422, 429]) {
        assert.equal(isRetryableStatus(status), false, `${status} must not retry`);
    }
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(undefined), false);
});

test('a 2xx forward reports success after exactly one request', async () => {
    const crm = await crmStub([200]);
    const restore = withEnv(crm.url);
    try {
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.SUCCESS);
        assert.equal(result.status, 200);
        assert.equal(result.attempts, 1);
        assert.equal(crm.received.length, 1);
        assert.equal(crm.received[0].signature, 'test-bot-crm-forward-secret-0123456789abcdef');
        assert.equal(crm.received[0].payload.connectionId, BOT_CONNECTION);
        assert.equal(crm.received[0].payload.providerAccountId, String(BOT_ACCOUNT));
        assert.equal(crm.received[0].payload.providerEventId, 'update:1001');
    } finally {
        restore();
        await crm.close();
    }
});

test('a /start deep-link payload is never forwarded to the CRM', async () => {
    const token = 'r_0123456789abcdef0123456789abcdef';
    const crm = await crmStub([200]);
    const restore = withEnv(crm.url);
    try {
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(telegramUpdate({ text: `/start ${token}` }), 'INCOMING');

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.SUCCESS);
        assert.equal(crm.received.length, 1);
        assert.equal(crm.received[0].payload.text, '/start');
        assert.ok(!JSON.stringify(crm.received[0].payload).includes(token.slice(2)));
    } finally {
        restore();
        await crm.close();
    }
});

for (const status of [400, 404, 409, 410, 413, 422]) {
    test(`a ${status} is terminal and is never retried`, async () => {
        const crm = await crmStub([status]);
        const restore = withEnv(crm.url);
        try {
            const service = new CrmIntegrationService();
            const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

            assert.equal(result.outcome, CRM_FORWARD_OUTCOME.TERMINAL_4XX);
            assert.equal(result.status, status);
            assert.equal(result.attempts, 1);
            assert.equal(crm.received.length, 1, 'a 4xx must produce exactly one request');
        } finally {
            restore();
            await crm.close();
        }
    });
}

for (const status of [500, 502, 503]) {
    test(`a ${status} is retried and exhausts as transient`, async () => {
        const crm = await crmStub([status]);
        const restore = withEnv(crm.url);
        try {
            const service = new CrmIntegrationService();
            const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

            assert.equal(result.outcome, CRM_FORWARD_OUTCOME.RETRY_EXHAUSTED_TRANSIENT);
            assert.equal(crm.received.length, 4, 'one attempt plus three retries');
        } finally {
            restore();
            await crm.close();
        }
    });
}

test('a transient fault that clears reports one successful completion', async () => {
    const crm = await crmStub([503, 200]);
    const restore = withEnv(crm.url);
    try {
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.SUCCESS);
        assert.equal(result.status, 200);
        assert.equal(crm.received.length, 2);
    } finally {
        restore();
        await crm.close();
    }
});

test('a network error is retried and exhausts as transient', async () => {
    // Bind then close, so the port is certain to refuse connections.
    const crm = await crmStub([200]);
    const url = crm.url;
    await crm.close();
    const restore = withEnv(url);
    try {
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.RETRY_EXHAUSTED_TRANSIENT);
        assert.equal(result.reason, 'transport_error');
    } finally {
        restore();
    }
});

test('a timeout is retried and exhausts as transient, starting one chain per attempt', async () => {
    const crm = await crmStub(['hang']);
    const restore = withEnv(crm.url, { BOT_CRM_FORWARD_TIMEOUT_MS: '120' });
    try {
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.RETRY_EXHAUSTED_TRANSIENT);
        assert.equal(result.reason, 'timeout');
        // destroy() on timeout also emits 'error'. Without the terminate guard
        // each timeout would fork a second retry chain and the count would grow
        // past four.
        assert.equal(crm.received.length, 4, 'exactly one chain of four attempts');
    } finally {
        restore();
        await crm.close();
    }
});

test('a refused event does not poison the next independent event', async () => {
    const crm = await crmStub([401, 200]);
    const restore = withEnv(crm.url);
    try {
        const service = new CrmIntegrationService();

        const eventA = await service.forwardMessageToCrm(
            telegramUpdate({ updateId: 1001, messageId: 2001 }), 'INCOMING',
        );
        const eventB = await service.forwardMessageToCrm(
            telegramUpdate({ updateId: 1002, messageId: 2002, text: 'second' }), 'INCOMING',
        );

        // An auth refusal is deferred (kept when an outbox exists), never a latch.
        assert.equal(eventA.outcome, CRM_FORWARD_OUTCOME.DEFERRED);
        assert.equal(eventB.outcome, CRM_FORWARD_OUTCOME.SUCCESS);
        assert.equal(crm.received.length, 2, 'no shared latch, no blocked queue');
        assert.equal(crm.received[1].payload.providerEventId, 'update:1002');
    } finally {
        restore();
        await crm.close();
    }
});

test('an unbound runtime refuses locally without contacting the CRM', async () => {
    const crm = await crmStub([200]);
    const restore = withEnv(crm.url, { CRM_TELEGRAM_CONNECTION_ID: '' });
    try {
        delete process.env.TELEGRAM_CONNECTION_ID;
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.UNBOUND);
        assert.equal(crm.received.length, 0);
    } finally {
        restore();
        await crm.close();
    }
});

test('an update with nothing forwardable is skipped, not failed', async () => {
    const crm = await crmStub([200]);
    const restore = withEnv(crm.url);
    try {
        const service = new CrmIntegrationService();
        const result = await service.forwardMessageToCrm(
            { botInfo: { id: BOT_ACCOUNT }, update: { update_id: 1 }, from: { id: 42 } },
            'INCOMING',
        );

        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.SKIPPED);
        assert.equal(crm.received.length, 0);
    } finally {
        restore();
        await crm.close();
    }
});

test('the forwarding middleware awaits the terminal outcome', () => {
    const { readFileSync } = require('node:fs');
    const path = require('node:path');
    const bot = readFileSync(path.resolve(__dirname, '../bot.js'), 'utf8');
    const code = bot
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    assert.match(code, /await\s+crmIntegration\.forwardMessageToCrm\(/);
    assert.doesNotMatch(
        code,
        /forwardMessageToCrm\([^)]*\)\s*\.catch\(/,
        'fire-and-forget forwarding must not return',
    );
});

// ── T3-O: durable redelivery outbox ─────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A real outbox in a fresh temporary directory (the production implementation). */
function memoryOutbox(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-outbox-'));
    const limits = Object.freeze({ ...redeliveryLimits({}), ...overrides });
    return {
        db: directory,
        outbox: createFileCrmOutbox(path.join(directory, 'outbox'), limits),
        close: async () => fs.rmSync(directory, { recursive: true, force: true }),
    };
}

async function rows(directory) {
    const dir = path.join(directory, 'outbox');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        const mode = fs.statSync(path.join(dir, n)).mode & 0o777;
        return { eventKey: entry.eventKey, attempts: entry.attempts, nextAt: entry.nextAt, createdAt: entry.createdAt, body: entry.body, mode };
    }).sort((x, y) => x.createdAt - y.createdAt);
}

function captureLogs() {
    const lines = [];
    const originals = {};
    for (const level of ['info', 'warn', 'error']) {
        originals[level] = logger[level];
        logger[level] = (...args) => { lines.push(args.map(String).join(' ')); };
    }
    return { lines, restore: () => Object.assign(logger, originals) };
}

test('an event the CRM could not take is kept and redelivered with its exact body, once', async () => {
    const crm = await crmStub([503]);
    const restore = withEnv(crm.url);
    const store = memoryOutbox();
    const logs = captureLogs();
    let clock = 1_800_000_000_000;
    try {
        const service = new CrmIntegrationService({ outbox: store.outbox, now: () => clock });
        const result = await service.forwardMessageToCrm(telegramUpdate({ text: 'PRIVATE-T3O-TEXT' }), 'INCOMING');
        assert.equal(result.outcome, CRM_FORWARD_OUTCOME.RETRY_EXHAUSTED_TRANSIENT);
        assert.equal(result.kept, true);
        assert.equal(result.body, undefined, 'the body never travels in the result');
        const kept = await rows(store.db);
        assert.equal(kept.length, 1);
        assert.equal(kept[0].eventKey, 'update:1001');
        assert.equal(kept[0].mode, 0o600, 'a kept event is readable by the bot only');
        assert.deepEqual(JSON.parse(kept[0].body), crm.received[0].payload);

        // Not due yet: nothing is sent.
        const before = crm.received.length;
        assert.deepEqual(await service.drainRedeliveryOutbox(), { delivered: 0, refused: 0, rescheduled: 0, purged: 0 });
        assert.equal(crm.received.length, before);

        // Due, and the CRM is back.
        await crm.close();
        const healthy = await crmStub([200]);
        service.crmWebhookUrl = healthy.url;
        clock += 31_000;
        const summary = await service.drainRedeliveryOutbox();
        assert.equal(summary.delivered, 1);
        assert.equal(healthy.received.length, 1);
        assert.deepEqual(healthy.received[0].payload, JSON.parse(kept[0].body));
        assert.equal(healthy.received[0].signature, 'test-bot-crm-forward-secret-0123456789abcdef');
        assert.deepEqual(await rows(store.db), [], 'a delivered event leaves no row');
        await healthy.close();
        for (const line of logs.lines) assert.doesNotMatch(line, /PRIVATE-T3O-TEXT|driver42/);
    } finally {
        logs.restore();
        restore();
        await store.close();
    }
});

test('a transient redelivery answer reschedules with backoff; a terminal one deletes', async () => {
    const restore = withEnv('http://127.0.0.1:9/api/webhook/telegram');
    const store = memoryOutbox();
    let clock = 1_800_000_000_000;
    try {
        await store.outbox.put('update:2002', JSON.stringify({ providerEventId: 'update:2002' }), clock);
        const flaky = await crmStub([503, 409]);
        const service = new CrmIntegrationService({ outbox: store.outbox, now: () => clock });
        service.crmWebhookUrl = flaky.url;
        clock += 31_000;
        assert.equal((await service.drainRedeliveryOutbox()).rescheduled, 1);
        let [row] = await rows(store.db);
        assert.equal(row.attempts, 1);
        assert.equal(row.nextAt, clock + redeliveryDelayMs(1, store.outbox.limits));
        // Explicit schedule: 30 s doubling (60 s after the first redelivery), capped at 15 min.
        assert.equal(row.nextAt - clock, 60_000);
        assert.equal(redeliveryDelayMs(10, store.outbox.limits), 15 * 60 * 1000);
        clock += redeliveryDelayMs(1, store.outbox.limits) - 1;
        assert.equal((await service.drainRedeliveryOutbox()).rescheduled, 0, 'not resent before it is due');
        clock += 1;
        assert.equal((await service.drainRedeliveryOutbox()).refused, 1);
        assert.deepEqual(await rows(store.db), [], 'a terminal refusal is not retried');
        assert.equal(flaky.received.length, 2);
        await flaky.close();
    } finally {
        restore();
        await store.close();
    }
});

test('success and terminal answers on the live path keep nothing', async () => {
    for (const status of [200, 409]) {
        const crm = await crmStub([status]);
        const restore = withEnv(crm.url);
        const store = memoryOutbox();
        try {
            const service = new CrmIntegrationService({ outbox: store.outbox });
            await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');
            assert.deepEqual(await rows(store.db), []);
        } finally {
            restore();
            await crm.close();
            await store.close();
        }
    }
});

test('the outbox is bounded: expired rows are purged, a full outbox keeps nothing new', async () => {
    const restore = withEnv('http://127.0.0.1:9/api/webhook/telegram');
    const store = memoryOutbox({ maxRows: 1, maxAgeMs: 60_000 });
    let clock = 1_800_000_000_000;
    try {
        assert.deepEqual(await store.outbox.put('update:1', '{}', clock), { stored: true, duplicate: false });
        assert.deepEqual(await store.outbox.put('update:2', '{}', clock), { stored: false, reason: 'full' });
        const crm = await crmStub([503]);
        const service = new CrmIntegrationService({ outbox: store.outbox, now: () => clock });
        service.crmWebhookUrl = crm.url;
        const result = await service.forwardMessageToCrm(telegramUpdate({ updateId: 3003 }), 'INCOMING');
        assert.equal(result.kept, false);
        clock += 60_001;
        assert.equal((await service.drainRedeliveryOutbox()).purged, 1);
        assert.deepEqual(await rows(store.db), []);
        await crm.close();
    } finally {
        restore();
        await store.close();
    }
});

test('without a strong secret the drain sends nothing and keeps every row', async () => {
    const restore = withEnv('http://127.0.0.1:9/api/webhook/telegram', { BOT_CRM_SECRET: 'short' });
    const store = memoryOutbox();
    let clock = 1_800_000_000_000;
    try {
        await store.outbox.put('update:4004', '{}', clock);
        const crm = await crmStub([200]);
        const service = new CrmIntegrationService({ outbox: store.outbox, now: () => clock });
        service.crmWebhookUrl = crm.url;
        clock += 31_000;
        await service.drainRedeliveryOutbox();
        assert.equal(crm.received.length, 0);
        assert.equal((await rows(store.db)).length, 1);
        await crm.close();
    } finally {
        restore();
        await store.close();
    }
});

test('the production instance keeps events durably and the bot starts the drainer', () => {
    const production = require('../services/crmIntegration');
    assert.ok(production.outbox, 'the exported instance has an outbox');
    assert.equal(crmOutboxDirectory({ BOT_SQLITE_PATH: '/app/data/bot.sqlite' }), '/app/data/crm-forward-outbox');
    assert.equal(crmOutboxDirectory({ BOT_CRM_OUTBOX_DIR: '/run/outbox', BOT_SQLITE_PATH: '/app/data/bot.sqlite' }), '/run/outbox');
    const bot = readFileSync(resolvePath(__dirname, '../bot.js'), 'utf8');
    assert.match(bot, /crmIntegration\.startRedeliveryDrainer\(\);/);
    const source = readFileSync(resolvePath(__dirname, '../services/crmIntegration.js'), 'utf8');
    assert.doesNotMatch(source, /Message dropped\.`\)/, 'an exhausted event is never silently dropped');
    assert.doesNotMatch(source, /logger\.\w+\([^)]*\$\{(?:row\.body|redelivery\.body|data|body)\}/, 'no body in a log line');
});

// ── T3-O R1 (Security): auth and rate refusals are kept, never dropped ────

test('only 400/404/409/410/413/422 are terminal; every other 4xx is deferrable', () => {
    for (const status of [400, 404, 409, 410, 413, 422]) {
        assert.equal(isTerminalRefusal(status), true, `${status}`);
        assert.equal(isDeferrableRefusal(status), false, `${status}`);
    }
    for (const status of [401, 403, 405, 408, 415, 425, 429]) {
        assert.equal(isTerminalRefusal(status), false, `${status}`);
        assert.equal(isDeferrableRefusal(status), true, `${status}`);
    }
    for (const status of [200, 302, 500, 503, null]) assert.equal(isDeferrableRefusal(status), false, `${status}`);
});

for (const status of [401, 403, 408, 425, 429]) {
    test(`a live ${status} is kept for redelivery after one request, never dropped or hammered`, async () => {
        const crm = await crmStub([status]);
        const restore = withEnv(crm.url);
        const store = memoryOutbox();
        try {
            const service = new CrmIntegrationService({ outbox: store.outbox });
            const result = await service.forwardMessageToCrm(telegramUpdate(), 'INCOMING');
            assert.equal(result.outcome, CRM_FORWARD_OUTCOME.DEFERRED);
            assert.equal(result.kept, true);
            assert.equal(crm.received.length, 1, 'no in-line retry of an auth or rate refusal');
            const kept = await rows(store.db);
            assert.equal(kept.length, 1);
            assert.deepEqual(JSON.parse(kept[0].body), crm.received[0].payload);
        } finally {
            restore();
            await store.close();
        }
    });
}

test('the drainer keeps and reschedules auth/rate refusals; it deletes only terminal ones', async () => {
    const restore = withEnv('http://127.0.0.1:9/api/webhook/telegram');
    const store = memoryOutbox();
    let clock = 1_800_000_000_000;
    try {
        const service = new CrmIntegrationService({ outbox: store.outbox, now: () => clock });
        for (const [status, kept] of [[401, true], [403, true], [429, true], [400, false], [422, false]]) {
            const key = `update:${status}`;
            await store.outbox.put(key, JSON.stringify({ providerEventId: key }), clock);
            const crm = await crmStub([status]);
            service.crmWebhookUrl = crm.url;
            clock += 16 * 60 * 1000;
            await service.drainRedeliveryOutbox();
            const left = (await rows(store.db)).filter(row => row.eventKey === key);
            assert.equal(left.length, kept ? 1 : 0, `status ${status}`);
            if (kept) assert.ok(left[0].attempts >= 1, `status ${status} rescheduled`);
            await crm.close();
            for (const row of await rows(store.db)) await store.outbox.remove(row.eventKey);
        }
    } finally {
        restore();
        await store.close();
    }
});

test('an existing outbox directory with wider permissions is tightened to 0700', async () => {
    const store = memoryOutbox();
    try {
        const dir = path.join(store.db, 'outbox');
        fs.mkdirSync(dir, { mode: 0o755 });
        fs.chmodSync(dir, 0o755);
        await store.outbox.put('update:5005', '{}', 1_800_000_000_000);
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    } finally {
        await store.close();
    }
});

