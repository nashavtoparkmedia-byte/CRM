/**
 * Same dance as gravity-mvp/src/lib/ai-call/proxy-fetch.ts but for the
 * bridge process. Node.js fetch doesn't honour HTTPS_PROXY out of the
 * box — wrap it manually via undici ProxyAgent.
 *
 * Set HTTPS_PROXY (or OPENAI_HTTPS_PROXY for OpenAI-specific routing)
 * in the bridge environment to route LLM/STT/TTS HTTP calls through
 * your VPN. Without the env var, behaviour is unchanged.
 */

let cachedAgent = null
let cachedAgentProxy = null

function getProxy() {
    return (
        process.env.OPENAI_HTTPS_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy ||
        null
    )
}

async function getDispatcher() {
    const proxy = getProxy()
    if (!proxy) return null
    if (cachedAgent && cachedAgentProxy === proxy) return cachedAgent
    try {
        const { ProxyAgent } = require('undici')
        cachedAgent = new ProxyAgent(proxy)
        cachedAgentProxy = proxy
        return cachedAgent
    } catch (err) {
        console.error(`[bridge/proxy-fetch] failed to load undici ProxyAgent: ${err.message}`)
        return null
    }
}

/** Merge proxy dispatcher into fetch init when available. */
async function withProxy(init = {}) {
    const dispatcher = await getDispatcher()
    if (!dispatcher) return init
    return { ...init, dispatcher }
}

function isProxyConfigured() {
    return !!getProxy()
}

module.exports = { withProxy, isProxyConfigured }
