/**
 * Process-wide HTTPS proxy initialiser for the AudioBridge.
 *
 * Same idea as gravity-mvp/src/lib/ai-call/init-proxy.ts — set
 * undici.setGlobalDispatcher on boot so every fetch in the bridge
 * (LLM, STT, TTS) honours the proxy without per-callsite plumbing.
 *
 * Set HTTPS_PROXY (typical Xray HTTP inbound: http://127.0.0.1:10809)
 * in the bridge environment. Without it the bridge keeps going direct.
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
