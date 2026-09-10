/**
 * Minimal ESL client for issuing one `originate` command from CRM to
 * FreeSWITCH. Reused by /api/ai-calls/start to launch a live AI-call leg.
 *
 * Why a bespoke client instead of `esl` / `modesl`:
 *   - We only need 2 commands per call (auth, api originate). Both are
 *     short text frames. A direct TCP socket is ~80 LOC and avoids adding
 *     a dependency that would have to live in the gravity-mvp lockfile.
 *
 * Returns the FS response body (usually "+OK <uuid>" or "-ERR ...") so
 * the caller can verify the channel was created.
 */

import net from 'node:net'

interface EslConnectionOptions {
    host: string
    port: number
    password: string
}

interface OriginateOpts {
    /** Explicit, pre-validated connection settings. Live calls have no defaults. */
    connection: EslConnectionOptions
    /** Pre-allocated UUID for the new channel; bridge resolves the call by this. */
    fsUuid: string
    /** Dial string, e.g. "user/103" or "sofia/external/+79193654871@gateway" */
    dialString: string
    /** Destination extension in the dialplan, default '9999' (AI-call park). */
    extension?: string
    /** Optional caller-id name for the originator. */
    callerIdName?: string
    /** Optional channel variables to set before dial. */
    vars?: Record<string, string>
    /** Network timeout in milliseconds. */
    timeoutMs?: number
}

export class EslOriginateRejectedError extends Error {
    constructor() {
        super('FreeSWITCH rejected the originate command')
        this.name = 'EslOriginateRejectedError'
    }
}

export class EslOriginateUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'EslOriginateUnavailableError'
    }
}

export class EslOriginateOutcomeUnknownError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'EslOriginateOutcomeUnknownError'
    }
}

export function requireSuccessfulOriginateResponse(body: string): string {
    const response = body.trim()
    if (!response.startsWith('+OK')) {
        throw new EslOriginateRejectedError()
    }
    return response
}

export async function originateAiCall({
    connection,
    fsUuid,
    dialString,
    extension = '9999',
    callerIdName,
    vars = {},
    timeoutMs = 10_000,
}: OriginateOpts): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const sock = net.connect(connection.port, connection.host)
        sock.setEncoding('utf8')
        let buf = ''
        let stage: 'connecting' | 'authenticating' | 'awaiting_response' | 'done' = 'connecting'

        const transportError = (message: string): Error => stage === 'awaiting_response'
            ? new EslOriginateOutcomeUnknownError(message)
            : new EslOriginateUnavailableError(message)

        const timer = setTimeout(() => {
            sock.destroy()
            reject(transportError(`ESL timeout after ${timeoutMs}ms (stage=${stage})`))
        }, timeoutMs)

        sock.on('data', chunk => {
            buf += chunk

            if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
                stage = 'authenticating'
                buf = ''
                sock.write(`auth ${connection.password}\n\n`)
                return
            }

            if (stage === 'authenticating') {
                if (buf.includes('+OK accepted')) {
                    stage = 'awaiting_response'
                    buf = ''
                    // Assemble channel variables. origination_uuid is required —
                    // it lets the bridge resolve the Call row by UUID later.
                    const varParts: string[] = [`origination_uuid=${fsUuid}`]
                    if (callerIdName) varParts.push(`origination_caller_id_name='${callerIdName}'`)
                    for (const [k, v] of Object.entries(vars)) {
                        varParts.push(`${k}=${v}`)
                    }
                    const varBlock = `{${varParts.join(',')}}`
                    sock.write(`api originate ${varBlock}${dialString} ${extension} XML default\n\n`)
                    return
                }
                if (buf.includes('-ERR')) {
                    clearTimeout(timer)
                    sock.destroy()
                    reject(new EslOriginateUnavailableError('ESL authentication failed'))
                    return
                }
            }

            if (stage === 'awaiting_response') {
                const respIdx = buf.indexOf('Content-Type: api/response')
                if (respIdx === -1) return
                const respBuf = buf.substring(respIdx)
                const m = respBuf.match(/Content-Length: (\d+)\r?\n\r?\n([\s\S]*)/)
                if (m) {
                    const expectedLen = Number(m[1])
                    const body = m[2]
                    if (Buffer.byteLength(body, 'utf8') >= expectedLen) {
                        clearTimeout(timer)
                        stage = 'done'
                        sock.removeAllListeners('data')
                        sock.end()
                        try {
                            resolve(requireSuccessfulOriginateResponse(body))
                        } catch (error) {
                            reject(error)
                        }
                    }
                }
            }
        })

        sock.on('error', err => {
            clearTimeout(timer)
            reject(transportError(err.message))
        })
    })
}
