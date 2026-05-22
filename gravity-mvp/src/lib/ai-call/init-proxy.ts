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
        // PR9.5: split-tunnel dispatcher — proxy ТОЛЬКО для внешних
        // адресов. localhost / 127.0.0.1 / WSL должны идти direct,
        // иначе наш fetch к max-scraper :3005 заворачивался в VPN
        // и падал по таймауту, хотя scraper отвечает 200.
        //
        // Стратегия: создаём ProxyAgent + Agent (direct), делаем
        // wrapper-dispatcher, который смотрит на host в URL и
        // выбирает один из двух. setGlobalDispatcher этим wrapper'ом.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProxyAgent, Agent, setGlobalDispatcher } = require('undici')
        const proxyAgent  = new ProxyAgent(proxy)
        const directAgent = new Agent()

        // Hosts которые НЕ должны идти через прокси.
        // Дополнительные NO_PROXY из env (CSV).
        const noProxyCsv = process.env.NO_PROXY || process.env.no_proxy || ''
        const noProxyHosts = new Set<string>([
            'localhost', '127.0.0.1', '::1', '0.0.0.0',
            ...noProxyCsv.split(',').map(s => s.trim()).filter(Boolean),
        ])

        const isLocalHost = (host: string): boolean => {
            if (!host) return false
            const h = host.toLowerCase()
            if (noProxyHosts.has(h)) return true
            // 192.168.x.x / 10.x.x.x / 172.16-31.x.x — privates
            if (/^192\.168\./.test(h)) return true
            if (/^10\./.test(h)) return true
            if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
            // *.local
            if (h.endsWith('.local') || h.endsWith('.localhost')) return true
            return false
        }

        // Custom Dispatcher: deлегирует ProxyAgent или Agent по hostname.
        // undici Dispatcher API: extend with dispatch(opts, handler).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wrapper: any = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dispatch(opts: any, handler: any) {
                try {
                    const url = opts.origin ? new URL(opts.origin) : null
                    const host = url?.hostname ?? ''
                    if (isLocalHost(host)) {
                        return directAgent.dispatch(opts, handler)
                    }
                } catch {
                    // fall through to proxy
                }
                return proxyAgent.dispatch(opts, handler)
            },
            close()  { return Promise.all([proxyAgent.close(),  directAgent.close()])  },
            destroy(){ return Promise.all([proxyAgent.destroy(), directAgent.destroy()]) },
        }

        setGlobalDispatcher(wrapper)
        console.log(`[ai-call/proxy] split-tunnel dispatcher: localhost/private → direct, external → ${redactProxy(proxy)}`)
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
