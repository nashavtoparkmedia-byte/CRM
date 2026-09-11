import { type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
    getMobileSessionPrincipalV1,
    writeDerivedUiIdentityCookie,
} from '@/modules/identity-access/public/v1/mobile-session-auth'

/**
 * GET /messages/open — the server-side gate a notification tap goes through.
 *
 * The Android shell never builds a `/messages?id=…` URL. It hands this route a
 * chat identifier and the CRM decides where the browser actually lands. That
 * puts three decisions on the server, where they belong:
 *
 *  1. Is there a session? An expired one is sent to the mobile login screen
 *     carrying this exact URL as the return destination, so the operator lands
 *     on the conversation they tapped rather than on a generic home screen.
 *  2. Does the conversation exist? An unknown or deleted id lands on the chat
 *     list instead of a broken screen, and the shell learns nothing about it.
 *  3. Which channel tab is correct? It is derived from the conversation's own
 *     stored channel, not from the notification payload — so a wrong or stale
 *     tab in a payload cannot mislead the UI.
 *
 * The route is read-only on purpose. Opening a notification must not mark
 * anything read, and nothing here writes to Chat or Message. The only cookie
 * it touches is the derived UI identity value, re-written from the verified
 * session so it cannot drift from it.
 *
 * `phone` and `driver` are deliberately not accepted. `/messages?phone=` runs
 * a `prisma.chat.create` on GET, and a notification-driven path must never be
 * able to reach a write.
 *
 * Every redirect is RELATIVE. `NextResponse.redirect` needs an absolute URL,
 * and the absolute URL it would be given is derived from the server's own
 * binding rather than the request host — behind the production Nginx that
 * resolves to the container address, not yokoone.ru, and the deep link breaks.
 * A relative Location is resolved by the client against the URL it actually
 * requested, which is the correct host by construction and also removes any
 * chance of this route emitting an off-origin destination.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Conversation channel as stored, to the tab id the Messenger URL expects. */
const CHANNEL_TAB_BY_STORED_CHANNEL: Record<string, string> = {
    telegram: 'tg',
    whatsapp: 'wa',
    max: 'max',
    avito: 'av',
    phone: 'phone',
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** 303: the client must follow with GET, whatever method arrived. */
function seeOther(location: string): Response {
    return new Response(null, { status: 303, headers: { Location: location } })
}

export async function GET(request: NextRequest) {
    const requestUrl = new URL(request.url)
    const chatId = requestUrl.searchParams.get('chat')?.trim() ?? ''
    const messageId = requestUrl.searchParams.get('msg')?.trim() ?? ''

    // Rebuild the return destination from validated parts only, so whatever
    // else was on the incoming URL cannot ride along through the login screen.
    const returnTo = SAFE_ID.test(chatId)
        ? `/messages/open?chat=${encodeURIComponent(chatId)}${SAFE_ID.test(messageId) ? `&msg=${encodeURIComponent(messageId)}` : ''}`
        : '/messages'

    const principal = await getMobileSessionPrincipalV1()
    if (!principal) {
        return seeOther(`/login/mobile?next=${encodeURIComponent(returnTo)}`)
    }

    // Keep the UI identity value in step with the session that justifies it.
    await writeDerivedUiIdentityCookie(principal)

    if (!SAFE_ID.test(chatId)) {
        console.warn('[mobile-open] rejected target: identifier failed validation')
        return seeOther('/messages')
    }

    const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, channel: true },
    })

    if (!chat) {
        console.warn('[mobile-open] refused target: no such conversation')
        return seeOther('/messages?open=unavailable')
    }

    const destination = new URLSearchParams()
    destination.set('id', chat.id)
    const tab = CHANNEL_TAB_BY_STORED_CHANNEL[chat.channel]
    if (tab) destination.set('channel', tab)
    if (SAFE_ID.test(messageId)) destination.set('msg', messageId)

    return seeOther(`/messages?${destination.toString()}`)
}
