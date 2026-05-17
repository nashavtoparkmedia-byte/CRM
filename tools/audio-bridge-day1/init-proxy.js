/**
 * Process-wide HTTPS proxy initialiser for the AudioBridge.
 *
 * Mirrors gravity-mvp/src/lib/ai-call/init-proxy.ts — install
 * undici.setGlobalDispatcher on boot so every outbound provider fetch
 * (LLM, STT, TTS) honours the proxy without per-callsite plumbing.
 *
 * Set HTTPS_PROXY (typical Xray HTTP inbound: http://127.0.0.1:10809)
 * in the bridge environment. Without it the bridge keeps going direct.
 *
 * IMPORTANT — bridge ALSO talks to its local CRM (127.0.0.1:3002). A
 * naïve global ProxyAgent routes loopback through Xray too, and Xray
 * refuses local destinations. The fix is two-sided:
 *   1) Here: install ProxyAgent globally so OpenAI / Yandex fetches that
 *      don't pass an explicit dispatcher pick it up.
 *   2) crm-client.js: pass an explicit Agent() (proxy-free dispatcher)
 *      to every fetch against the CRM, so those bypass the global one.
 *
 * Reason for not using EnvHttpProxyAgent with NO_PROXY: in undici 8 the
 * NO_PROXY matcher for raw IPv4 literals is unreliable cross-platform.
 * An explicit local Agent in crm-client.js is deterministic and tiny.
 */

let initialised = false

function initProxy() {
    if (initialised) return
    initialised = true

    const proxy =
        process.env.OPENAI_HTTPS_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy

    if (!proxy) {
        console.log('[bridge/proxy] no HTTPS_PROXY env — outbound fetch goes direct')
        return
    }

    try {
        const { ProxyAgent, setGlobalDispatcher } = require('undici')
        setGlobalDispatcher(new ProxyAgent(proxy))
        console.log(`[bridge/proxy] global dispatcher set → ${redactProxy(proxy)}`)
        console.log('[bridge/proxy] crm-client uses a separate direct dispatcher for 127.0.0.1:3002')
    } catch (err) {
        console.error(`[bridge/proxy] failed to set global dispatcher: ${err.message}`)
    }
}

function redactProxy(url) {
    try {
        const u = new URL(url)
        if (u.username || u.password) {
            u.username = '***'
            u.password = ''
        }
        return u.toString()
    } catch {
        return url.replace(/\/\/[^@]+@/, '//***@')
    }
}

module.exports = { initProxy }
