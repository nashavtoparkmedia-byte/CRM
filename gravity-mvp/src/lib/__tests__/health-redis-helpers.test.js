'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { encodeRespCommand, redisHealthTarget } = require('../health-redis-helpers')

test('redis health target uses authenticated production URL without exposing it as inline protocol', () => {
    const target = redisHealthTarget({ REDIS_URL: 'redis://:p%40ss%20word@redis:6380' })
    assert.deepEqual(target, { host: 'redis', port: 6380, authParts: ['AUTH', 'p@ss word'] })
    assert.equal(encodeRespCommand(target.authParts).toString('utf8'), '*2\r\n$4\r\nAUTH\r\n$9\r\np@ss word\r\n')
})

test('redis health target supports ACL username and password', () => {
    const target = redisHealthTarget({ REDIS_URL: 'redis://health:p%40ss@redis:6379/0' })
    assert.deepEqual(target.authParts, ['AUTH', 'health', 'p@ss'])
    assert.equal(encodeRespCommand(target.authParts).toString('utf8'), '*3\r\n$4\r\nAUTH\r\n$6\r\nhealth\r\n$4\r\np@ss\r\n')
})

test('redis password fallback is used when URL omits credentials', () => {
    const target = redisHealthTarget({ REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'fixed-secret' })
    assert.deepEqual(target.authParts, ['AUTH', 'fixed-secret'])
})

test('RESP framing prevents command injection through credential content', () => {
    const encoded = encodeRespCommand(['AUTH', 'line1\r\nPING'])
    assert.equal(encoded.toString('utf8'), '*2\r\n$4\r\nAUTH\r\n$11\r\nline1\r\nPING\r\n')
})

test('invalid Redis schemes and ports fail closed', () => {
    assert.throws(() => redisHealthTarget({ REDIS_URL: 'rediss://redis:6379' }), /redis_url_invalid/)
    assert.throws(() => redisHealthTarget({ REDIS_HOST: 'redis', REDIS_PORT: '70000' }), /redis_port_invalid/)
})

test('unauthenticated local target emits only RESP PING', () => {
    const target = redisHealthTarget({})
    assert.deepEqual(target, { host: '127.0.0.1', port: 6379, authParts: null })
    assert.equal(encodeRespCommand(['PING']).toString('utf8'), '*1\r\n$4\r\nPING\r\n')
})
