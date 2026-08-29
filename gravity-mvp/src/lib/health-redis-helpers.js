'use strict'

function decodeComponent(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        throw new Error('redis_url_encoding_invalid')
    }
}

function parsePort(value, fallback) {
    const port = value === '' || value === undefined ? fallback : Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('redis_port_invalid')
    }
    return port
}

function redisHealthTarget(env) {
    const rawUrl = env.REDIS_URL
    if (rawUrl) {
        let url
        try {
            url = new URL(rawUrl)
        } catch {
            throw new Error('redis_url_invalid')
        }
        if (url.protocol !== 'redis:' || !url.hostname || url.search || url.hash) {
            throw new Error('redis_url_invalid')
        }
        const username = decodeComponent(url.username)
        const urlPassword = decodeComponent(url.password)
        const password = urlPassword || env.REDIS_PASSWORD || ''
        if (username && !password) {
            throw new Error('redis_auth_invalid')
        }
        return {
            host: url.hostname,
            port: parsePort(url.port, 6379),
            authParts: password ? (username ? ['AUTH', username, password] : ['AUTH', password]) : null,
        }
    }
    const host = env.REDIS_HOST || '127.0.0.1'
    const password = env.REDIS_PASSWORD || ''
    return {
        host,
        port: parsePort(env.REDIS_PORT, 6379),
        authParts: password ? ['AUTH', password] : null,
    }
}

function encodeRespCommand(parts) {
    if (!Array.isArray(parts) || parts.length === 0 || parts.some(part => typeof part !== 'string')) {
        throw new Error('redis_command_invalid')
    }
    const chunks = [Buffer.from(`*${parts.length}\r\n`, 'ascii')]
    for (const part of parts) {
        const value = Buffer.from(part, 'utf8')
        chunks.push(Buffer.from(`$${value.length}\r\n`, 'ascii'), value, Buffer.from('\r\n', 'ascii'))
    }
    return Buffer.concat(chunks)
}

module.exports = { encodeRespCommand, redisHealthTarget }
