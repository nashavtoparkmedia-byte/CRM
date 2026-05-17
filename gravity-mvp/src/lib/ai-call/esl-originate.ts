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

const FS_ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const FS_ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const FS_ESL_PASSWORD = process.env.FS_ESL_PASSWORD ?? 'ClueCon'

interface OriginateOpts {
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

export async function originateAiCall({
    fsUuid,
    dialString,
    extension = '9999',
    callerIdName,
    vars = {},
    timeoutMs = 10_000,
}: OriginateOpts): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const sock = net.connect(FS_ESL_PORT, FS_ESL_HOST)
        sock.setEncoding('utf8')
        let buf = ''
        let stage = 'connecting'

        const timer = setTimeout(() => {
            sock.destroy()
            reject(new Error(`ESL timeout after ${timeoutMs}ms (stage=${stage})`))
        }, timeoutMs)

        sock.on('data', chunk => {
            buf += chunk

            if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
                stage = 'authenticating'
                buf = ''
                sock.write(`auth ${FS_ESL_PASSWORD}\n\n`)
                return
            }

            if (stage === 'authenticating') {
                if (buf.includes('+OK accepted')) {
                    stage = 'sending'
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
                    reject(new Error(`ESL auth failed: ${buf.split('\n').find(l => l.includes('-ERR'))}`))
                    return
                }
            }

            if (stage === 'sending') {
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
                        resolve(body.trim())
                    }
                }
            }
        })

        sock.on('error', err => {
            clearTimeout(timer)
            reject(err)
        })
    })
}
