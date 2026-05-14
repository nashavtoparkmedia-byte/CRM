import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { getTelephonyAiConfig, updateTelephonyAiConfig } from '@/lib/aiCallAnalysis/config'
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/aiCallAnalysis/prompt'

/**
 * GET /api/settings/telephony-ai
 *
 * Returns the singleton TelephonyAiConfig — model + editable system prompt
 * + enabled flag. Auto-creates the row with defaults on first read.
 *
 * PUT /api/settings/telephony-ai
 *
 * Updates the config. Body: { enabled?, model?, systemPrompt? }. Admin-only.
 *
 * GET also returns the built-in default prompt as `defaultPrompt` so the
 * settings UI can offer a one-click "Сбросить к шаблону" button.
 */
export async function GET() {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    try {
        const config = await getTelephonyAiConfig()
        return NextResponse.json({ config, defaultPrompt: DEFAULT_SYSTEM_PROMPT })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

export async function PUT(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    // Only Руководитель/Администратор may change the prompt. Менеджеры — нет.
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    try {
        const body = await req.json().catch(() => ({}))
        const patch: { enabled?: boolean; model?: string; systemPrompt?: string } = {}

        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.model === 'string' && body.model.trim().length > 0) {
            patch.model = body.model.trim()
        }
        if (typeof body.systemPrompt === 'string') {
            const trimmed = body.systemPrompt.trim()
            if (trimmed.length === 0) {
                return NextResponse.json({ error: 'systemPrompt cannot be empty' }, { status: 400 })
            }
            patch.systemPrompt = trimmed
        }

        if (Object.keys(patch).length === 0) {
            return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
        }

        const config = await updateTelephonyAiConfig(patch)
        return NextResponse.json({ config })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
