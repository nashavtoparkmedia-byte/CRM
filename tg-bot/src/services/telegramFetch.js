'use strict';

const { createTelegramProxyAgent, getTelegramProxyConfig } = require('./telegramProxyAgent');

function createTelegramFetch({
    env = process.env,
    globalFetch = (...args) => fetch(...args),
    loadNodeFetch = () => import('node-fetch').then(({ default: nodeFetch }) => nodeFetch),
} = {}) {
    // Keep one agent for the process. It is used only for api.telegram.org;
    // CRM, PostgreSQL, Google APIs, and other fetch callers stay direct.
    const telegramAgent = createTelegramProxyAgent(getTelegramProxyConfig(env));
    let nodeFetchPromise;

    return async function telegramFetch(url, options = {}) {
        const target = new URL(String(url));
        if (target.hostname !== 'api.telegram.org' || !telegramAgent) {
            return globalFetch(url, options);
        }

        nodeFetchPromise ??= loadNodeFetch();
        const nodeFetch = await nodeFetchPromise;
        return nodeFetch(url, { ...options, agent: telegramAgent });
    };
}

const telegramFetch = createTelegramFetch();

module.exports = { createTelegramFetch, telegramFetch };
