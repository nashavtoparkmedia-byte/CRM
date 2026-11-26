'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTelegramFetch } = require('./telegramFetch');

test('keeps CRM requests direct when Telegram proxy is configured', async () => {
    const calls = [];
    const telegramFetch = createTelegramFetch({
        env: {
            NODE_ENV: 'production',
            TELEGRAM_HTTP_PROXY: 'http://192.168.0.102:10810',
            TELEGRAM_HTTP_PROXY_USER: 'synthetic-user',
            TELEGRAM_HTTP_PROXY_PASSWORD: 'synthetic-password',
        },
        globalFetch: async (...args) => { calls.push(args); return { ok: true }; },
        loadNodeFetch: async () => { throw new Error('Node fetch must not be loaded for CRM'); },
    });

    await telegramFetch('http://gravity-mvp:3002/api/webhooks/bot', { method: 'POST' });
    assert.deepEqual(calls, [['http://gravity-mvp:3002/api/webhooks/bot', { method: 'POST' }]]);
});

test('routes Telegram HTTPS through a scoped agent, without global fetch', async () => {
    let proxyOptions;
    let nodeFetchCalls = 0;
    const telegramFetch = createTelegramFetch({
        env: {
            NODE_ENV: 'production',
            TELEGRAM_HTTP_PROXY: 'http://192.168.0.102:10810',
            TELEGRAM_HTTP_PROXY_USER: 'synthetic-user',
            TELEGRAM_HTTP_PROXY_PASSWORD: 'synthetic-password',
        },
        globalFetch: async () => { throw new Error('Global fetch must not be used for proxied Telegram'); },
        loadNodeFetch: async () => async (_url, options) => {
            nodeFetchCalls += 1;
            proxyOptions = options;
            return { status: 302 };
        },
    });

    const result = await telegramFetch('https://api.telegram.org/', { method: 'GET' });
    assert.equal(result.status, 302);
    assert.equal(nodeFetchCalls, 1);
    assert.ok(proxyOptions.agent);
    assert.equal(proxyOptions.method, 'GET');
});

test('node-fetch uses the scoped CONNECT agent for Telegram calls', async () => {
    let connectTarget = '';
    let authAccepted = false;
    const proxy = http.createServer();
    proxy.on('connect', (request, socket) => {
        connectTarget = request.url;
        authAccepted = request.headers['proxy-authorization'] ===
            `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`;
        socket.end('HTTP/1.1 502 mock upstream\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const telegramFetch = createTelegramFetch({
        env: {
            NODE_ENV: 'production',
            TELEGRAM_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
            TELEGRAM_HTTP_PROXY_USER: 'synthetic-user',
            TELEGRAM_HTTP_PROXY_PASSWORD: 'synthetic-password',
        },
    });
    try {
        const response = await telegramFetch('https://api.telegram.org/');
        assert.equal(response.status, 502);
        await response.arrayBuffer();
        assert.equal(connectTarget, 'api.telegram.org:443');
        assert.equal(authAccepted, true);
    } finally {
        await new Promise((resolve) => proxy.close(resolve));
    }
});
