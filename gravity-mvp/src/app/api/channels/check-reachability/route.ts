import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { findIdentityByPhoneAndChannel, updateReachability } from '@/lib/ReachabilityService'

/**
 * POST /api/channels/check-reachability
 *
 * Live-check whether a phone number is reachable on Telegram or WhatsApp.
 * Only supports channel = 'telegram' | 'whatsapp'. Other channels return 400.
 *
 * Response: { reachable: boolean, error?: string }
 *
 * On timeout or internal check failure, returns { reachable: true } —
 * this is a soft fallback meaning "don't show a warning",
 * NOT "the number is confirmed reachable".
 * Soft fallback does NOT update persisted reachabilityStatus.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { phone: rawPhone, channel } = body

    if (!rawPhone || !channel) {
      return NextResponse.json(
        { error: 'phone and channel are required' },
        { status: 400 }
      )
    }

    if (channel !== 'telegram' && channel !== 'whatsapp') {
      return NextResponse.json(
        { error: `Pre-check is only supported for telegram and whatsapp` },
        { status: 400 }
      )
    }

    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    let result: { reachable: boolean; telegramId?: string; error?: string }

    if (channel === 'telegram') {
      const { checkTelegramReachability } = await import('@/app/tg-actions')
      result = await checkTelegramReachability(normalized)
    } else {
      const { checkReachability } = await import('@/lib/whatsapp/WhatsAppService')
      result = await checkReachability(normalized)
    }

    // Persist result only for definitive outcomes (not soft fallback).
    // Soft fallback returns reachable:true but was triggered by timeout/error,
    // so we only persist when we got a real answer (reachable:false is always real;
    // reachable:true with telegramId is real for TG; for WA reachable:true without
    // error is a real positive check).
    const isDefinitive = result.reachable === false || result.telegramId
    if (isDefinitive) {
      const identityId = await findIdentityByPhoneAndChannel(normalized, channel)
      if (identityId) {
        await updateReachability(identityId, result.reachable ? 'confirmed' : 'unreachable')
      }
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[check-reachability] Error:', err.message)
    return NextResponse.json({ reachable: true })
  }
}
