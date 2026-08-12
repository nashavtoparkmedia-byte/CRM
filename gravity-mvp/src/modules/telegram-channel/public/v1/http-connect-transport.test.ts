import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import {
    TelegramHttpConnectSocketV1,
    getTelegramTransportOptionsV1,
} from './http-connect-transport'

const originalHost = process.env.TG_HTTP_PROXY_HOST
const originalPort = process.env.TG_HTTP_PROXY_PORT

afterEach(() => {
    if (originalHost === undefined) delete process.env.TG_HTTP_PROXY_HOST
    else process.env.TG_HTTP_PROXY_HOST = originalHost
    if (originalPort === undefined) delete process.env.TG_HTTP_PROXY_PORT
    else process.env.TG_HTTP_PROXY_PORT = originalPort
})

describe('Telegram owner HTTP CONNECT transport', () => {
    it('keeps SOCKS precedence and selects HTTP CONNECT only when configured', () => {
        expect(getTelegramTransportOptionsV1({
            TG_PROXY_HOST: 'socks.local',
            TG_PROXY_PORT: '1080',
            TG_HTTP_PROXY_HOST: 'http.local',
            TG_HTTP_PROXY_PORT: '3128',
        }).label).toBe('SOCKS5 socks.local:1080')
        expect(getTelegramTransportOptionsV1({
            TG_HTTP_PROXY_HOST: 'http.local',
            TG_HTTP_PROXY_PORT: '3128',
        }).label).toBe('HTTP CONNECT http.local:3128')
    })

    it('opens a CONNECT tunnel and preserves bytes after the proxy response', async () => {
        const server = net.createServer(client => {
            let handshaken = false
            let pending = Buffer.alloc(0)
            client.on('data', data => {
                if (handshaken) {
                    client.write(data)
                    return
                }
                pending = Buffer.concat([pending, data])
                if (pending.indexOf('\r\n\r\n') === -1) return
                handshaken = true
                expect(pending.toString('latin1')).toContain('CONNECT 149.154.167.50:80 HTTP/1.1')
                client.write(Buffer.concat([
                    Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'),
                    Buffer.from('abc'),
                ]))
            })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('test server did not bind')

        process.env.TG_HTTP_PROXY_HOST = '127.0.0.1'
        process.env.TG_HTTP_PROXY_PORT = String(address.port)
        const socket = new TelegramHttpConnectSocketV1()

        try {
            await socket.connect(80, '149.154.167.50')
            expect((await socket.readExactly(3)).toString()).toBe('abc')
            socket.write(Buffer.from('ping'))
            expect((await socket.readExactly(4)).toString()).toBe('ping')
        } finally {
            await socket.close()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })
})
