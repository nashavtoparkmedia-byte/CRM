// Redis readiness probe used by /api/health/infra.
// CommonJS on purpose: unit tests can require it without a TS loader.
'use strict'

const net = require('node:net')

function parseRedisConfig(env = process.env) {
    const fallbackHost = env.REDIS_HOST || '127.0.0.1'
    const fallbackPort = Number(env.REDIS_PORT || 6379)
    const url = env.REDIS_URL
    if (!url) return { host: fallbackHost, port: fallbackPort, password: env.REDIS_PASSWORD || '' }
    try {
        const parsed = new URL(url)
        return {
            host: parsed.hostname || fallbackHost,
            port: Number(parsed.port || 6379),
            password: parsed.password ? decodeURIComponent(parsed.password) : (env.REDIS_PASSWORD || ''),
        }
    } catch {
        return { host: fallbackHost, port: fallbackPort, password: env.REDIS_PASSWORD || '' }
    }
}

function respCommand(parts) {
    return `*${parts.length}\r\n` + parts.map(part => {
        const value = String(part)
        return `$${Buffer.byteLength(value)}\r\n${value}\r\n`
    }).join('')
}

function classifyRedisResponse(text, stage) {
    if (stage === 'auth') {
        if (text.startsWith('+OK')) return { ok: true }
        if (text.startsWith('-NOAUTH') || text.startsWith('-WRONGPASS') || text.startsWith('-ERR invalid password') || text.startsWith('-ERR AUTH')) {
            return { ok: false, error: 'authentication_failure' }
        }
        return { ok: false, error: 'unexpected_response' }
    }
    if (text.includes('PONG')) return { ok: true }
    if (text.startsWith('-NOAUTH')) return { ok: false, error: 'authentication_failure' }
    return { ok: false, error: 'unexpected_response' }
}

async function pingRedis(options = {}) {
    const start = Date.now()
    const env = options.env || process.env
    const config = options.config || parseRedisConfig(env)
    const socketFactory = options.socketFactory || ((opts) => net.createConnection(opts))

    return new Promise((resolve) => {
        const sock = socketFactory({ host: config.host, port: config.port })
        let settled = false
        let stage = config.password ? 'auth' : 'ping'
        const finish = (ok, error) => {
            if (settled) return
            settled = true
            try { sock.destroy() } catch {}
            resolve({ name: 'redis', ok, ms: Date.now() - start, ...(error ? { error } : {}) })
        }
        sock.once('connect', () => {
            sock.write(config.password ? respCommand(['AUTH', config.password]) : respCommand(['PING']))
        })
        sock.on('data', (buf) => {
            const text = buf.toString('utf8')
            const result = classifyRedisResponse(text, stage)
            if (!result.ok) return finish(false, result.error)
            if (stage === 'auth') {
                stage = 'ping'
                sock.write(respCommand(['PING']))
                return
            }
            finish(true)
        })
        sock.once('error', () => finish(false, 'connection_failure'))
    })
}

module.exports = { pingRedis, parseRedisConfig, respCommand, classifyRedisResponse }
