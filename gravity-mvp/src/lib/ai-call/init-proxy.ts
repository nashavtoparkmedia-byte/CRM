/**
 * Process-wide HTTPS proxy initialiser.
 *
 * Node.js `fetch` (built on undici) does NOT read HTTPS_PROXY out of the
 * box. That includes the official `openai` SDK, which delegates to fetch
 * internally. Setting `undici.setGlobalDispatcher(new ProxyAgent(...))`
 * at process boot reroutes ALL outbound fetch calls through the proxy
 * in a single place — no per-endpoint plumbing required.
 *
 * We use the user's VPN HTTP proxy (port 10809 in the typical Xray
 * config). SOCKS5 on 10808 would need a third-party socks dispatcher;
 * HTTP is supported by undici natively.
 *
 * Env vars (first non-empty wins):
 *   OPENAI_HTTPS_PROXY  — explicit, for OpenAI-only routing if you
 *                         build per-provider dispatchers later
 *   HTTPS_PROXY         — standard
 *   HTTP_PROXY          — fallback
 *
 * Idempotent — calling twice is a no-op. Logs once on first call.
 *
 * Don't import this in client components. It pulls in undici which is
 * Node-only.
 */

let initialised = false

export function initProxy(): void {
    if (initialised) return
    initialised = true

    const proxy =
        process.env.OPENAI_HTTPS_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy

    if (!proxy) {
        console.log('[ai-call/proxy] no HTTPS_PROXY env — outbound fetch goes direct')
        return
    }

    try {
        // Dynamic require keeps the module tree clean for edge builds.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProxyAgent, setGlobalDispatcher } = require('undici')
        setGlobalDispatcher(new ProxyAgent(proxy))
        console.log(`[ai-call/proxy] global dispatcher set → ${redactProxy(proxy)}`)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ai-call/proxy] failed to set global dispatcher: ${msg}`)
    }
}

/** Hide auth credentials when the proxy URL contains them. */
function redactProxy(url: string): string {
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
