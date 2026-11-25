'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { createTelegramProxyAgent, getTelegramProxyConfig } = require('./telegramProxyAgent');

test('HTTP proxy overrides the development SOCKS default', () => {
    assert.deepEqual(getTelegramProxyConfig({
        NODE_ENV: 'development',
        TELEGRAM_HTTP_PROXY: 'http://host.docker.internal:10809',
    }), {
        httpProxyUrl: 'http://host.docker.internal:10809',
        httpProxyUser: '',
        httpProxyPassword: '',
        socksProxyUrl: '',
    });
    assert.deepEqual(getTelegramProxyConfig({ NODE_ENV: 'production' }), {
        httpProxyUrl: '',
        httpProxyUser: '',
        httpProxyPassword: '',
        socksProxyUrl: '',
    });
});

test('configures an HTTP CONNECT proxy only on the Telegram HTTPS agent', async () => {
    let connectTarget = '';
    let authorization = '';
    const proxy = http.createServer();
    proxy.on('connect', (request, socket) => {
        connectTarget = request.url;
        authorization = request.headers['proxy-authorization'] || '';
        socket.end('HTTP/1.1 502 mock upstream\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const agent = createTelegramProxyAgent({
        httpProxyUrl: `http://127.0.0.1:${proxy.address().port}`,
        httpProxyUser: 'synthetic-user',
        httpProxyPassword: 'synthetic-password',
    });
    try {
        const response = await new Promise((resolve, reject) => {
            const request = https.get('https://api.telegram.org/getMe', { agent, timeout: 1000 }, resolve);
            request.on('error', reject);
        });
        response.resume();
        assert.equal(response.statusCode, 502);
        assert.equal(connectTarget, 'api.telegram.org:443');
        assert.equal(authorization, `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`);
    } finally {
        agent.destroy();
        await new Promise((resolve) => proxy.close(resolve));
    }
});

test('rejects simultaneous proxy modes and malformed HTTP proxy URLs', () => {
    assert.throws(() => createTelegramProxyAgent({ httpProxyUrl: 'http://127.0.0.1:1', socksProxyUrl: 'socks5://127.0.0.1:2' }), { message: 'TELEGRAM_PROXY_CONFIG_CONFLICT' });
    assert.throws(() => createTelegramProxyAgent({ httpProxyUrl: 'socks5://127.0.0.1:1' }), { message: 'TELEGRAM_HTTP_PROXY_INVALID' });
    assert.throws(() => createTelegramProxyAgent({ httpProxyUrl: 'http://user:password@127.0.0.1:1' }), { message: 'TELEGRAM_HTTP_PROXY_INVALID' });
    assert.throws(() => createTelegramProxyAgent({ httpProxyUrl: 'http://127.0.0.1:1', httpProxyUser: 'user' }), { message: 'TELEGRAM_HTTP_PROXY_AUTH_INVALID' });
    assert.throws(() => createTelegramProxyAgent({ httpProxyUser: 'user', httpProxyPassword: 'password' }), { message: 'TELEGRAM_HTTP_PROXY_URL_REQUIRED' });
});

test('keeps optional SOCKS proxy mode available', () => {
    assert.ok(createTelegramProxyAgent({ socksProxyUrl: 'socks5://127.0.0.1:10808' }));
});
