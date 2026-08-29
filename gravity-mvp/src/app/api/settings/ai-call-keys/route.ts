/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AiProviderSetting may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { getAiCallProviderStatusV1 } from '@/modules/calling/public/v1/ai-call-provider-status'
import {
    deleteAiCallProviderSettingV1,
    saveAiCallProviderSettingV1,
    type AiCallProvider as Provider,
    type AiCallProviderSettingKey as Key,
} from '@/modules/calling/public/v1/ai-call-provider-settings'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/ai-call-keys
 *
 * Returns only the configuration STATUS for each AI-call key — never the
 * secret values. Status includes source ('db' | 'env' | 'none') so the UI
 * can tell admins whether they're still on a .env fallback.
 *
 * Admin / Руководитель only — even masks (last-4 chars) and source labels
 * can be a useful signal for an attacker trying to reverse-engineer which
 * provider/account a key belongs to.
 */
export async function GET() {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const status = await getAiCallProviderStatusV1()
    return NextResponse.json(status)
}

/**
 * POST /api/settings/ai-call-keys
 *
 * Save one setting. Body shapes:
 *   { provider: 'openai',  key: 'apiKey',  value: 'sk-...' }
 *   { provider: 'yandex',  key: 'apiKey',  value: 'AQVN...' }
 *   { provider: 'yandex',  key: 'folderId', value: 'b1g...' }
 *   { provider: 'system',  key: 'mockMode', value: 'true' | 'false' }
 *
 * Secrets (apiKey) get AES-256-GCM encrypted. Public values (folderId,
 * mockMode) go in valuePlain.
 *
 * Admin / Руководитель only.
 */
export async function POST(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const provider = body.provider as Provider
    const key = body.key as Key
    const value: string = (body.value ?? '').toString()

    if (!provider || !key) {
        return NextResponse.json({ error: 'provider_and_key_required' }, { status: 400 })
    }
    if (!isValidPair(provider, key)) {
        return NextResponse.json({ error: 'invalid_provider_key_pair' }, { status: 400 })
    }
    if (provider === 'system' && key === 'mockMode' && value !== 'true' && value !== 'false') {
        return NextResponse.json({ error: 'mockMode_value_must_be_true_or_false' }, { status: 400 })
    }

    // Empty / whitespace value would silently drop the existing row via
    // saveValue → deleteValue. That's surprising at the API surface (UI
    // already blocks the case, but a stray curl shouldn't be able to
    // erase a key without explicit DELETE). Reject it.
    if (!value.trim()) {
        return NextResponse.json(
            { error: 'empty_value_not_allowed', hint: 'use DELETE to remove a key' },
            { status: 400 },
        )
    }

    // Secret iff it's an apiKey. folderId is public, mockMode is a boolean
    // string — neither needs encryption.
    const isSecret = key === 'apiKey'
    await saveAiCallProviderSettingV1(provider, key, value, { secret: isSecret })
    return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/settings/ai-call-keys?provider=openai&key=apiKey
 *
 * Drop one stored setting. (We use query params instead of path segments
 * here so the existing /api/settings/ai-call-keys URL stays the single
 * touch-point — the [provider]/[key] flavour the spec mentions is just
 * naming sugar and would require new route folders.)
 */
export async function DELETE(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const url = new URL(req.url)
    const provider = url.searchParams.get('provider') as Provider | null
    const key = url.searchParams.get('key') as Key | null
    if (!provider || !key || !isValidPair(provider, key)) {
        return NextResponse.json({ error: 'invalid_provider_key_pair' }, { status: 400 })
    }

    await deleteAiCallProviderSettingV1(provider, key)
    return NextResponse.json({ ok: true })
}

function isValidPair(provider: Provider, key: Key): boolean {
    if (provider === 'openai' && key === 'apiKey') return true
    if (provider === 'yandex' && (key === 'apiKey' || key === 'folderId')) return true
    if (provider === 'system' && (key === 'mockMode' || key === 'activeProjectId')) return true
    return false
}
