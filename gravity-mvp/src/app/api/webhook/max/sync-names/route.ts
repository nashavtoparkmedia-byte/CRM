/**
 * PR-П: Endpoint для max-web-scraper — принимает пары (chatId, name)
 * из MAX UI и обновляет placeholder-имена чатов.
 *
 * Body: { pairs: [{chatId: "51849311", name: "Андрей"}, ...] }
 *
 * Логика:
 *   1. Для каждой пары: ищем Chat по externalChatId
 *   2. Если current chat.name placeholder И new name полезное → update
 *   3. Также обновляем Contact.displayName если placeholder
 *   4. Никогда не overwrite-им хорошие имена
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
    PROMOTE_PLACEHOLDER_DISPLAY_NAME_V1,
    RESOLVE_CONTACT_COMMAND_V1,
} from '@/contracts/contacts/v1'
import { resolveContactV1 } from '@/modules/contacts/public/v1'

function isPlaceholderName(name?: string | null): boolean {
    if (!name) return true
    const t = name.trim()
    if (!t) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)[\s:]+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    return false
}

/**
 * Нормализация имени из MAX UI: убирает a11y-префиксы.
 * MAX-веб для screen readers оборачивает имя как "Окно чата с <Имя>".
 * Также есть EN-вариант "Chat with <Name>".
 */
function normalizeMaxName(name: string): string {
    let t = name.trim()
    const rus = t.match(/^Окно чата с\s+(.+)$/i)
    if (rus) t = rus[1].trim()
    t = t.replace(/^(Chat with|Чат с)\s+/i, '').trim()
    return t
}

function isUsefulName(name?: string | null): boolean {
    if (!name) return false
    const t = name.trim()
    if (!t) return false
    // Должно быть либо имя (буквы), либо телефон (минимум 10 цифр)
    if (/[А-Яа-яA-Za-z]{2,}/.test(t)) return true
    const digits = t.replace(/\D/g, '')
    if (digits.length >= 10) return true
    return false
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const pairs: Array<{ chatId: string; name: string }> = body.pairs || []

        if (!Array.isArray(pairs)) {
            return NextResponse.json({ error: 'pairs must be array' }, { status: 400 })
        }

        let updated = 0
        let skipped_placeholder_input = 0
        let skipped_already_good = 0
        let not_found = 0

        for (const pair of pairs) {
            if (!pair?.chatId || !pair?.name) continue

            const newName = normalizeMaxName(pair.name)
            if (!isUsefulName(newName)) {
                skipped_placeholder_input++
                continue
            }

            const chat = await prisma.chat.findUnique({
                where: { externalChatId: String(pair.chatId) },
                select: { id: true, name: true, contactId: true },
            })
            if (!chat) {
                not_found++
                continue
            }
            if (!isPlaceholderName(chat.name)) {
                skipped_already_good++
                continue
            }

            await prisma.chat.update({
                where: { id: chat.id },
                data: { name: newName },
            })

            // Contact update — только если он тоже placeholder
            if (chat.contactId) {
                await resolveContactV1({
                    contract: RESOLVE_CONTACT_COMMAND_V1,
                    operation: PROMOTE_PLACEHOLDER_DISPLAY_NAME_V1,
                    contactId: chat.contactId,
                    candidateDisplayName: newName,
                })
            }

            updated++
            console.log(`[MAX-SYNC] chatId=${pair.chatId} «${chat.name ?? 'null'}» → «${newName}»`)
        }

        return NextResponse.json({
            updated,
            skipped_already_good,
            skipped_placeholder_input,
            not_found,
            total: pairs.length,
        })
    } catch (error: any) {
        console.error('[MAX-SYNC] error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
