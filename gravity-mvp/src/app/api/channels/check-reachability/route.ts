import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { findIdentityByPhoneAndChannel, updateReachability } from '@/lib/ReachabilityService'
import { prisma } from '@/lib/prisma'

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

    let result: { reachable: boolean; telegramId?: string; confirmed?: boolean; error?: string }

    if (channel === 'telegram') {
      const { checkTelegramReachability } = await import('@/app/tg-actions')
      result = await checkTelegramReachability(normalized)
    } else {
      const { checkReachability } = await import('@/lib/whatsapp/WhatsAppService')
      result = await checkReachability(normalized)
    }

    // Persist result only for definitive outcomes (not soft fallback).
    // Definitive если: явный negative, либо явный positive с маркером (TG: telegramId, WA: confirmed).
    // Без маркера reachable:true — это soft fallback (timeout/no connection/etc), не персистим.
    const isDefinitive = result.reachable === false || !!result.telegramId || !!result.confirmed
    if (isDefinitive) {
      const identityId = await findIdentityByPhoneAndChannel(normalized, channel)
      if (identityId) {
        if (result.reachable === false) {
          // isRegisteredUser can return false due to privacy settings or WA API limitations.
          // Protect existing 'confirmed' identities — a single negative live check is not
          // enough evidence to override confirmed-via-actual-communication status.
          const existing = await prisma.contactIdentity.findUnique({
            where: { id: identityId },
            select: { reachabilityStatus: true },
          })
          if (existing?.reachabilityStatus === 'confirmed') {
            return NextResponse.json({ reachable: true })
          }
        }
        await updateReachability(identityId, result.reachable ? 'confirmed' : 'unreachable')
      }
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[check-reachability] Error:', err.message)
    return NextResponse.json({ reachable: true })
  }
}
