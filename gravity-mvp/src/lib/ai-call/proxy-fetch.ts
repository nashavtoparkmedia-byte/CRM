/* eslint-disable @typescript-eslint/no-explicit-any -- undici types are
   not bundled in @types/node; the runtime accepts the option fine. */

/**
 * Node.js `fetch` (built on undici) does NOT honour HTTP(S)_PROXY env vars
 * out of the box. Browsers do; Node doesn't. This matters for outbound
 * calls to providers that geo-block parts of the world (OpenAI returns
 * HTTP 403 with code `unsupported_country_region_territory` for RU IPs).
 *
 * If you're behind a VPN proxy, set:
 *   HTTPS_PROXY=http://127.0.0.1:8080
 *   # or socks5://127.0.0.1:1080
 *
 * Helper below picks the env var, builds an undici ProxyAgent on demand,
 * and merges it into the fetch options as `dispatcher`. If no env var is
 * set, returns the options unchanged — drop-in safe everywhere.
 *
 * Usage:
 *   const res = await fetch(url, await withProxy({ headers: {...} }))
 */

let cachedAgent: any = null
let cachedAgentProxy: string | null = null

function getProxy(): string | null {
    return (
        process.env.OPENAI_HTTPS_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy ||
        null
    )
}

async function buildAgent(proxyUrl: string): Promise<any> {
    if (cachedAgent && cachedAgentProxy === proxyUrl) return cachedAgent
    // Dynamic import — undici is bundled with Node but not in browser builds.
    // Wrapping in try/catch keeps the route compilable even if Next.js
    // can't resolve `undici` in a particular build.
    try {
        const { ProxyAgent } = await import('undici')
        cachedAgent = new ProxyAgent(proxyUrl)
        cachedAgentProxy = proxyUrl
        return cachedAgent
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ai-call/proxy-fetch] failed to load undici ProxyAgent: ${msg}`)
        return null
    }
}

/**
 * Merge a dispatcher into fetch RequestInit if a proxy is configured.
 * Returns the input unchanged when no proxy env var is set.
 */
export async function withProxy(init: RequestInit = {}): Promise<RequestInit> {
    const proxy = getProxy()
    if (!proxy) return init
    const agent = await buildAgent(proxy)
    if (!agent) return init
    // `dispatcher` is a Node-fetch undici-specific option; not in the
    // standard DOM RequestInit. We cast through any.
    return { ...init, dispatcher: agent } as any
}

/** Report whether the helper will actually proxy at runtime. */
export function isProxyConfigured(): boolean {
    return !!getProxy()
}
