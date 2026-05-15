/**
 * GET /api/avito/responses
 *
 * Возвращает все Avito-отклики из avito_responses (без a2u-* системных
 * сообщений). Используется на странице /avito (Client Component).
 *
 * Прав-ле проверка не требуется — CRM-сессия уже гарантирована
 * middleware/auth-системой. Если нужна гранулярность по ролям —
 * добавить здесь getCurrentUser() и фильтр.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.avito_responses.findMany({
      where: {
        NOT: { external_id: { startsWith: 'a2u-' } },
      },
      orderBy: { detected_at: 'desc' },
      take: 500,
    })
    // camelCase ключи как в Box 1 API — чтобы Client Component (порт)
    // работал без переименования.
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        externalId: r.external_id,
        externalIdSource: r.external_id_source,
        chatHref: r.chat_href,
        chatUrl: r.chat_url,
        candidateName: r.candidate_name,
        vacancyTitle: r.vacancy_title,
        phone: r.phone,
        receivedAt: r.received_at,
        detectedAt: r.detected_at,
        isUnreadDetected: r.is_unread_detected,
        status: r.status,
        rawDataJson: r.raw_data_json,
        preview: r.preview,
        phoneRevealedAt: r.phone_revealed_at,
        phoneRevealFailureReason: r.phone_reveal_failure_reason,
        processedAt: r.processed_at,
        processedBy: r.processed_by,
        autoReplySentAt: r.auto_reply_sent_at,
        autoReplyStatus: r.auto_reply_status,
        autoReplyError: r.auto_reply_error,
        telegramMessageId: r.telegram_message_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    )
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
