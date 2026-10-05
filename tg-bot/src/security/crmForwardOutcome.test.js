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
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    CrmIntegrationService,
    CRM_FORWARD_OUTCOME,
    isRetryableStatus,
} = require('../services/crmIntegration');

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
    return {
        url: `http://127.0.0.1:${server.address().port}/api/webhook/telegram`,
        received,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

function withEnv(url, extra = {}) {
    const previous = { ...process.env };
    process.env.CRM_WEBHOOK_URL = url;
    process.env.CRM_TELEGRAM_CONNECTION_ID = BOT_CONNECTION;
    process.env.BOT_CRM_SECRET = 'test-bot-secret';
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
        assert.equal(crm.received[0].signature, 'test-bot-secret');
        assert.equal(crm.received[0].payload.connectionId, BOT_CONNECTION);
        assert.equal(crm.received[0].payload.providerAccountId, String(BOT_ACCOUNT));
        assert.equal(crm.received[0].payload.providerEventId, 'update:1001');
    } finally {
        restore();
        await crm.close();
    }
});

for (const status of [400, 401, 403, 404, 409]) {
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

        assert.equal(eventA.outcome, CRM_FORWARD_OUTCOME.TERMINAL_4XX);
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
