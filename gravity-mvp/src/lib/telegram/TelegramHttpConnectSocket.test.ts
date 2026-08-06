import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TelegramHttpConnectSocket } from './TelegramHttpConnectSocket'

const originalHost = process.env.TG_HTTP_PROXY_HOST
const originalPort = process.env.TG_HTTP_PROXY_PORT

afterEach(() => {
    if (originalHost === undefined) delete process.env.TG_HTTP_PROXY_HOST
    else process.env.TG_HTTP_PROXY_HOST = originalHost
    if (originalPort === undefined) delete process.env.TG_HTTP_PROXY_PORT
    else process.env.TG_HTTP_PROXY_PORT = originalPort
})

describe('TelegramHttpConnectSocket', () => {
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
        const socket = new TelegramHttpConnectSocket()

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
