/**
 * Backfill reachabilityStatus for existing ContactIdentity records.
 *
 * Logic:
 * - For each identity, find the linked Chat(s)
 * - Find the last outbound message in those chats
 * - delivered / read → confirmed
 * - failed → unreachable
 * - no outbound messages → unknown (leave default)
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('Starting reachability backfill...')

  const identities = await prisma.contactIdentity.findMany({
    where: { isActive: true },
    select: {
      id: true,
      channel: true,
      externalId: true,
      reachabilityStatus: true,
      chats: { select: { id: true } },
    },
  })

  console.log(`Found ${identities.length} active identities`)

  let confirmed = 0
  let unreachable = 0
  let unknown = 0
  let skipped = 0

  for (const identity of identities) {
    // Skip if already has a non-unknown status (idempotent)
    if (identity.reachabilityStatus !== 'unknown') {
      skipped++
      continue
    }

    const chatIds = identity.chats.map(c => c.id)
    if (chatIds.length === 0) {
      unknown++
      continue
    }

    // Find the last outbound message across all linked chats
    const lastOutbound = await prisma.message.findFirst({
      where: {
        chatId: { in: chatIds },
        direction: 'outbound',
        status: { in: ['delivered', 'read', 'failed', 'sent'] },
      },
      orderBy: { sentAt: 'desc' },
      select: { status: true, sentAt: true },
    })

    if (!lastOutbound) {
      unknown++
      continue
    }

    let newStatus
    if (lastOutbound.status === 'delivered' || lastOutbound.status === 'read' || lastOutbound.status === 'sent') {
      newStatus = 'confirmed'
      confirmed++
    } else if (lastOutbound.status === 'failed') {
      newStatus = 'unreachable'
      unreachable++
    } else {
      unknown++
      continue
    }

    await prisma.contactIdentity.update({
      where: { id: identity.id },
      data: {
        reachabilityStatus: newStatus,
        reachabilityCheckedAt: lastOutbound.sentAt,
      },
    })
  }

  console.log('\nBackfill complete:')
  console.log(`  confirmed:   ${confirmed}`)
  console.log(`  unreachable: ${unreachable}`)
  console.log(`  unknown:     ${unknown}`)
  console.log(`  skipped:     ${skipped} (already set)`)
  console.log(`  total:       ${identities.length}`)
}

main()
  .catch(e => { console.error('FATAL:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
