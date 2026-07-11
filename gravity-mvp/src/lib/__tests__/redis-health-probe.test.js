'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

const { pingRedis, parseRedisConfig } = require('../redis-health-probe')

function onceServer(handler) {
    const server = net.createServer(socket => handler(socket))
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            resolve({ server, port })
        })
    })
}

async function withServer(handler, fn) {
    const { server, port } = await onceServer(handler)
    try {
        return await fn(port)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

test('parseRedisConfig reads REDIS_URL password without exposing it', () => {
    const cfg = parseRedisConfig({ REDIS_URL: 'redis://:secret%21@redis:6380/0' })
    assert.equal(cfg.host, 'redis')
    assert.equal(cfg.port, 6380)
    assert.equal(cfg.password, 'secret!')
})

test('Redis without password replies PONG', async () => {
    await withServer(socket => {
        socket.on('data', () => socket.write('+PONG\r\n'))
    }, async port => {
        const r = await pingRedis({ config: { host: '127.0.0.1', port, password: '' } })
        assert.equal(r.ok, true)
    })
})

test('Redis with auth sends AUTH before PING and returns ok', async () => {
    const seen = []
    await withServer(socket => {
        socket.on('data', chunk => {
            seen.push(chunk.toString('utf8'))
            if (seen.length === 1) socket.write('+OK\r\n')
            else socket.write('+PONG\r\n')
        })
    }, async port => {
        const r = await pingRedis({ config: { host: '127.0.0.1', port, password: 'secret' } })
        assert.equal(r.ok, true)
        assert.match(seen[0], /AUTH/)
        assert.match(seen[1], /PING/)
    })
})

test('wrong password is classified without leaking password', async () => {
    await withServer(socket => {
        socket.on('data', () => socket.write('-WRONGPASS invalid username-password pair\r\n'))
    }, async port => {
        const r = await pingRedis({ config: { host: '127.0.0.1', port, password: 'top-secret' } })
        assert.equal(r.ok, false)
        assert.equal(r.error, 'authentication_failure')
        assert.doesNotMatch(JSON.stringify(r), /top-secret/)
    })
})

test('unavailable Redis is connection_failure', async () => {
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    await new Promise(resolve => server.close(resolve))
    const r = await pingRedis({ config: { host: '127.0.0.1', port, password: '' } })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'connection_failure')
})

test('unexpected response is classified', async () => {
    await withServer(socket => {
        socket.on('data', () => socket.write('+HELLO\r\n'))
    }, async port => {
        const r = await pingRedis({ config: { host: '127.0.0.1', port, password: '' } })
        assert.equal(r.ok, false)
        assert.equal(r.error, 'unexpected_response')
    })
})
