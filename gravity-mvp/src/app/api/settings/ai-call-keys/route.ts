import { NextResponse } from 'next/server'
import { getAiCallKeysStatus } from '@/lib/ai-call/keys-status'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/ai-call-keys
 *
 * Returns only the configuration STATUS for AI-call keys — never the
 * secret values themselves. Used by the settings page to render the
 * "настроено / не настроено" indicators and the last-4-char preview.
 *
 * The actual secrets stay in .env and are read directly by the bridge
 * and the future LLM/STT/TTS providers. There is intentionally no POST
 * handler — admins edit .env on disk and restart the dev server.
 */
export async function GET() {
    const status = getAiCallKeysStatus()
    return NextResponse.json(status)
}
