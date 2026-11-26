'use strict';

function getTelegramProxyConfig(env = process.env) {
    const httpProxyUrl = env.TELEGRAM_HTTP_PROXY || '';
    const httpProxyUser = env.TELEGRAM_HTTP_PROXY_USER || '';
    const httpProxyPassword = env.TELEGRAM_HTTP_PROXY_PASSWORD || '';
    const socksProxyUrl = env.TELEGRAM_SOCKS_PROXY ?? (
        httpProxyUrl || env.NODE_ENV === 'production' ? '' : 'socks5://127.0.0.1:10808'
    );
    return { httpProxyUrl, httpProxyUser, httpProxyPassword, socksProxyUrl };
}

function createTelegramProxyAgent({
    httpProxyUrl = '',
    httpProxyUser = '',
    httpProxyPassword = '',
    socksProxyUrl = '',
} = {}) {
    const httpUrl = String(httpProxyUrl).trim();
    const httpUser = String(httpProxyUser);
    const httpPassword = String(httpProxyPassword);
    const socksUrl = String(socksProxyUrl).trim();
    if (httpUrl && socksUrl) throw new Error('TELEGRAM_PROXY_CONFIG_CONFLICT');
    const safeProxyCredential = /^[A-Za-z0-9._~-]{1,128}$/;
    if ((Boolean(httpUser) !== Boolean(httpPassword)) ||
        (httpUser && (!safeProxyCredential.test(httpUser) || !safeProxyCredential.test(httpPassword)))) {
        throw new Error('TELEGRAM_HTTP_PROXY_AUTH_INVALID');
    }
    if (httpUrl) {
        const parsed = new URL(httpUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error('TELEGRAM_HTTP_PROXY_INVALID');
        }
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const headers = httpUser
            ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${httpUser}:${httpPassword}`).toString('base64')}` }
            : undefined;
        return new HttpsProxyAgent(parsed, headers ? { headers } : undefined);
    }
    if (httpUser || httpPassword) throw new Error('TELEGRAM_HTTP_PROXY_URL_REQUIRED');
    if (socksUrl) {
        const parsed = new URL(socksUrl);
        if (!['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
            throw new Error('TELEGRAM_SOCKS_PROXY_INVALID');
        }
        const { SocksProxyAgent } = require('socks-proxy-agent');
        return new SocksProxyAgent(parsed);
    }
    return undefined;
}

module.exports = { createTelegramProxyAgent, getTelegramProxyConfig };
