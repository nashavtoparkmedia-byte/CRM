import net from 'node:net'

const CLOSED_ERROR = new Error('Telegram HTTP CONNECT socket was closed')

/** GramJS-compatible network socket for an owner-configured HTTP CONNECT proxy. */
export class TelegramHttpConnectSocketV1 {
    private client?: net.Socket
    private closed = true
    private stream = Buffer.alloc(0)
    private canRead: Promise<boolean> = Promise.resolve(false)
    private resolveRead?: (value: boolean) => void

    constructor(_proxy?: unknown) {
        this.resetReadSignal()
    }

    private resetReadSignal(): void {
        this.canRead = new Promise(resolve => { this.resolveRead = resolve })
    }

    private markClosed(): void {
        this.closed = true
        this.resolveRead?.(false)
    }

    private enqueue(data: Buffer): void {
        if (data.length === 0) return
        this.stream = Buffer.concat([this.stream, data])
        this.resolveRead?.(true)
    }

    async readExactly(number: number): Promise<Buffer> {
        let data = Buffer.alloc(0)
        while (data.length < number) {
            data = Buffer.concat([data, await this.read(number - data.length)])
        }
        return data
    }

    async read(number: number): Promise<Buffer> {
        if (this.closed) throw CLOSED_ERROR
        const readable = await this.canRead
        if (!readable || this.closed) throw CLOSED_ERROR
        const data = this.stream.subarray(0, number)
        this.stream = this.stream.subarray(number)
        if (this.stream.length === 0) this.resetReadSignal()
        return data
    }

    async readAll(): Promise<Buffer> {
        if (this.closed) throw CLOSED_ERROR
        const readable = await this.canRead
        if (!readable || this.closed) throw CLOSED_ERROR
        const data = this.stream
        this.stream = Buffer.alloc(0)
        this.resetReadSignal()
        return data
    }

    async connect(port: number, ip: string): Promise<unknown> {
        const proxyHost = process.env.TG_HTTP_PROXY_HOST
        const proxyPort = Number(process.env.TG_HTTP_PROXY_PORT)
        if (!proxyHost || !Number.isInteger(proxyPort) || proxyPort <= 0) {
            throw new Error('TG_HTTP_PROXY_HOST/TG_HTTP_PROXY_PORT are required')
        }

        this.stream = Buffer.alloc(0)
        this.resetReadSignal()
        const socket = net.createConnection({ host: proxyHost, port: proxyPort })
        this.client = socket

        return new Promise((resolve, reject) => {
            let settled = false
            let handshake = Buffer.alloc(0)

            const cleanupHandshake = () => {
                socket.removeListener('connect', onConnect)
                socket.removeListener('data', onHandshakeData)
                socket.removeListener('error', onHandshakeError)
                socket.removeListener('timeout', onHandshakeTimeout)
            }
            const fail = (error: Error) => {
                if (settled) return
                settled = true
                cleanupHandshake()
                socket.destroy()
                this.markClosed()
                reject(error)
            }
            const onHandshakeError = (error: Error) => fail(error)
            const onHandshakeTimeout = () => fail(new Error('Telegram HTTP CONNECT proxy timeout'))
            const onConnect = () => {
                const target = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
                socket.write(
                    `CONNECT ${target} HTTP/1.1\r\n`
                    + `Host: ${target}\r\n`
                    + 'Proxy-Connection: Keep-Alive\r\n\r\n',
                )
            }
            const onHandshakeData = (chunk: Buffer) => {
                handshake = Buffer.concat([handshake, chunk])
                const end = handshake.indexOf('\r\n\r\n')
                if (end === -1) {
                    if (handshake.length > 16 * 1024) {
                        fail(new Error('Telegram HTTP CONNECT response is too large'))
                    }
                    return
                }

                const head = handshake.subarray(0, end).toString('latin1')
                if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
                    const status = head.split('\r\n', 1)[0] || 'invalid response'
                    fail(new Error(`Telegram HTTP CONNECT proxy rejected target: ${status}`))
                    return
                }

                settled = true
                cleanupHandshake()
                socket.setTimeout(0)
                this.closed = false
                socket.on('data', data => this.enqueue(data))
                socket.on('error', () => this.markClosed())
                socket.on('close', () => this.markClosed())
                const remaining = handshake.subarray(end + 4)
                if (remaining.length > 0) this.enqueue(remaining)
                resolve(this)
            }

            socket.setTimeout(10_000)
            socket.once('connect', onConnect)
            socket.on('data', onHandshakeData)
            socket.once('error', onHandshakeError)
            socket.once('timeout', onHandshakeTimeout)
        })
    }

    write(data: Buffer): void {
        if (this.closed || !this.client) throw CLOSED_ERROR
        this.client.write(data)
    }

    async close(): Promise<void> {
        this.markClosed()
        this.client?.destroy()
        this.client?.unref()
    }

    async receive(): Promise<void> {
        // GramJS installs its stream consumers after CONNECT succeeds.
    }

    toString(): string {
        return 'TelegramHttpConnectSocketV1'
    }
}

export type TelegramTransportOptionsV1 = {
    options: Record<string, unknown>
    label: string | null
}

/** Resolve mutually exclusive Telegram transports; existing SOCKS takes precedence. */
export function getTelegramTransportOptionsV1(
    env: Readonly<Record<string, string | undefined>> = process.env,
): TelegramTransportOptionsV1 {
    const socksHost = env.TG_PROXY_HOST
    const socksPort = env.TG_PROXY_PORT ? Number.parseInt(env.TG_PROXY_PORT, 10) : undefined
    if (socksHost && socksPort) {
        return {
            options: { proxy: { ip: socksHost, port: socksPort, socksType: 5 as const } },
            label: `SOCKS5 ${socksHost}:${socksPort}`,
        }
    }

    const httpHost = env.TG_HTTP_PROXY_HOST
    const httpPort = env.TG_HTTP_PROXY_PORT ? Number.parseInt(env.TG_HTTP_PROXY_PORT, 10) : undefined
    if (httpHost && httpPort) {
        return {
            options: { networkSocket: TelegramHttpConnectSocketV1 as any },
            label: `HTTP CONNECT ${httpHost}:${httpPort}`,
        }
    }

    return { options: {}, label: null }
}
