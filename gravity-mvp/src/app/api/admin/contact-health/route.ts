import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // Total counts
    const [totalChats, totalContacts, totalPhones, totalIdentities] = await Promise.all([
      prisma.chat.count(),
      prisma.contact.count(),
      prisma.contactPhone.count(),
      prisma.contactIdentity.count(),
    ])

    // Link coverage
    const chatsWithContact = await prisma.chat.count({ where: { contactId: { not: null } } })
    const chatsWithIdentity = await prisma.chat.count({ where: { contactIdentityId: { not: null } } })

    // Recent chats (last 24h) — dual write effectiveness
    const recentChats = await prisma.chat.count({
      where: { createdAt: { gte: oneDayAgo } },
    })
    const recentWithContact = await prisma.chat.count({
      where: { createdAt: { gte: oneDayAgo }, contactId: { not: null } },
    })
    const recentWithIdentity = await prisma.chat.count({
      where: { createdAt: { gte: oneDayAgo }, contactIdentityId: { not: null } },
    })

    // Chats missing contactId (created after migration)
    const migrationDate = new Date('2026-04-04T00:00:00Z')
    const postMigrationMissing = await prisma.chat.findMany({
      where: {
        createdAt: { gte: migrationDate },
        contactId: null,
      },
      select: { id: true, channel: true, externalChatId: true, createdAt: true },
      take: 20,
    })

    // Contact sources
    const contactsBySource = await prisma.contact.groupBy({
      by: ['masterSource'],
      _count: true,
    })

    // Identities by channel
    const identitiesByChannel = await prisma.contactIdentity.groupBy({
      by: ['channel'],
      _count: true,
    })

    // Last Yandex sync — most recent Contact with masterSource=yandex
    const lastSyncedContact = await prisma.contact.findFirst({
      where: { masterSource: 'yandex' },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    })

    // Duplicate phones
    const dupPhones = await prisma.$queryRaw<Array<{ phone: string; cnt: bigint }>>`
      SELECT phone, COUNT(DISTINCT "contactId") as cnt
      FROM "ContactPhone"
      WHERE "isActive" = true
      GROUP BY phone
      HAVING COUNT(DISTINCT "contactId") > 1
    `

    const contactPct = totalChats > 0 ? ((chatsWithContact / totalChats) * 100).toFixed(1) : '0'
    const identityPct = totalChats > 0 ? ((chatsWithIdentity / totalChats) * 100).toFixed(1) : '0'
    const recentContactPct = recentChats > 0 ? ((recentWithContact / recentChats) * 100).toFixed(1) : 'N/A'
    const recentIdentityPct = recentChats > 0 ? ((recentWithIdentity / recentChats) * 100).toFixed(1) : 'N/A'

    const healthy = Number(contactPct) >= 95 && postMigrationMissing.length === 0

    return NextResponse.json({
      status: healthy ? 'healthy' : 'warning',
      timestamp: now.toISOString(),
      totals: {
        contacts: totalContacts,
        phones: totalPhones,
        identities: totalIdentities,
        chats: totalChats,
      },
      coverage: {
        chatsWithContactId: `${chatsWithContact}/${totalChats} (${contactPct}%)`,
        chatsWithIdentityId: `${chatsWithIdentity}/${totalChats} (${identityPct}%)`,
      },
      recent24h: {
        newChats: recentChats,
        withContactId: `${recentWithContact}/${recentChats} (${recentContactPct}%)`,
        withIdentityId: `${recentWithIdentity}/${recentChats} (${recentIdentityPct}%)`,
      },
      contactsBySource: Object.fromEntries(
        contactsBySource.map(s => [s.masterSource, s._count])
      ),
      identitiesByChannel: Object.fromEntries(
        identitiesByChannel.map(s => [s.channel, s._count])
      ),
      lastSyncAt: lastSyncedContact?.updatedAt?.toISOString() || null,
      duplicatePhones: dupPhones.map(d => ({ phone: d.phone, contacts: Number(d.cnt) })),
      postMigrationMissing: postMigrationMissing.map(c => ({
        chatId: c.id,
        channel: c.channel,
        externalChatId: c.externalChatId,
        createdAt: c.createdAt,
      })),
    })
  } catch (err: any) {
    console.error('[contact-health] Error:', err.message)
    return NextResponse.json({ status: 'error', error: err.message }, { status: 500 })
  }
}
