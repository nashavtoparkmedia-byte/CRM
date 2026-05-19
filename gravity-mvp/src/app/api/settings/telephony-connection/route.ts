import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import { getCurrentUser } from '@/lib/users/user-service'
import { opsLog } from '@/lib/opsLog'

/**
 * GET / PUT  /api/settings/telephony-connection
 *
 * Megafon SIP-trunk credentials live in a FreeSWITCH gateway xml at
 *   <freeswitch_conf>/sip_profiles/external/megafon.xml
 *
 * GET:
 *   Parses the xml and returns the current params. Password is masked
 *   ('••••••••') unless the caller explicitly requests it with ?reveal=1
 *   AND is an admin. The masked sentinel lets the form distinguish
 *   "user didn't change the password" from "user typed an empty string".
 *
 * PUT:
 *   Rewrites the xml in-place with the provided fields. If `password`
 *   arrives as the masked sentinel, the existing value is kept; any
 *   other value replaces it. After the write, FreeSWITCH reloads the
 *   gateway via ESL (`sofia profile external killgw megafon` +
 *   `sofia profile external rescan`) so the new creds take effect
 *   without a server restart.
 *
 * The xml lives in WSL2 land; on Windows we reach it via the
 *   \\wsl$\Ubuntu-24.04\usr\local\freeswitch\conf
 * UNC path. Configurable through env `TELEPHONY_CONF_HOST_PATH`.
 */

const MASKED = '••••••••'

const PARAM_KEYS = [
    'username',
    'password',
    'realm',
    'proxy',
    'from-user',
    'from-domain',
    'register',
    'expire-seconds',
    'register-transport',
] as const

type ParamKey = typeof PARAM_KEYS[number]
type ParamMap = Partial<Record<ParamKey, string>>

function getConfPath(): string {
    const base = process.env.TELEPHONY_CONF_HOST_PATH
        ?? '\\\\wsl$\\Ubuntu-24.04\\usr\\local\\freeswitch\\conf'
    return path.join(base, 'sip_profiles', 'external', 'megafon.xml')
}

function parseParams(xml: string): ParamMap {
    const out: ParamMap = {}
    const re = /<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
        const [, name, value] = m
        if ((PARAM_KEYS as readonly string[]).includes(name)) {
            out[name as ParamKey] = value
        }
    }
    return out
}

function replaceParam(xml: string, name: string, value: string): string {
    const escaped = value.replace(/"/g, '&quot;')
    const re = new RegExp(`(<param\\s+name="${name.replace(/[-]/g, '\\$&')}"\\s+value=")[^"]*("\\s*\\/>)`, 'g')
    if (re.test(xml)) {
        return xml.replace(re, `$1${escaped}$2`)
    }
    // param not present — inject before </gateway>
    return xml.replace(/(<\/gateway>)/, `    <param name="${name}" value="${escaped}"/>\n  $1`)
}

async function rescanGateway(): Promise<{ ok: boolean; error?: string }> {
    try {
        const { getEslConnection } = await import('@/lib/freeswitch/EslClient')
        const conn = getEslConnection()
        if (!conn) return { ok: false, error: 'ESL not connected' }
        await new Promise<void>((resolve) => conn.api('sofia profile external killgw megafon', () => resolve()))
        await new Promise<void>((resolve) => conn.api('sofia profile external rescan', () => resolve()))
        return { ok: true }
    } catch (err: any) {
        return { ok: false, error: err.message }
    }
}

export async function GET(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const reveal = req.nextUrl.searchParams.get('reveal') === '1' &&
        (user.role === 'Администратор' || user.role === 'Руководитель')

    try {
        const xml = await fs.readFile(getConfPath(), 'utf-8')
        const params = parseParams(xml)
        const safe: ParamMap = { ...params }
        if (!reveal && safe.password) safe.password = MASKED
        return NextResponse.json({ ok: true, params: safe, path: getConfPath() })
    } catch (err: any) {
        return NextResponse.json({
            error: `Не удалось прочитать конфиг: ${err.message}`,
            path: getConfPath(),
        }, { status: 500 })
    }
}

export async function PUT(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const incoming: ParamMap = body?.params ?? {}
    const filtered: ParamMap = {}
    for (const k of PARAM_KEYS) {
        if (typeof incoming[k] === 'string') filtered[k] = String(incoming[k])
    }

    try {
        const confPath = getConfPath()
        let xml = await fs.readFile(confPath, 'utf-8')

        for (const [k, v] of Object.entries(filtered)) {
            if (v == null) continue
            // The form sends back the masked sentinel for fields the user
            // didn't touch — we must NOT overwrite the real password with it.
            if (k === 'password' && v === MASKED) continue
            xml = replaceParam(xml, k, v)
        }

        await fs.writeFile(confPath, xml, 'utf-8')

        const rescan = await rescanGateway()
        opsLog('info', 'telephony_connection_updated', {
            operation: 'settings',
            userId: user.id,
            rescanOk: rescan.ok,
            rescanError: rescan.error,
        })

        // Echo the new state (password still masked).
        const parsed = parseParams(xml)
        if (parsed.password) parsed.password = MASKED
        return NextResponse.json({ ok: true, params: parsed, rescan })
    } catch (err: any) {
        return NextResponse.json({ error: `Не удалось записать конфиг: ${err.message}` }, { status: 500 })
    }
}
