// Quick verification: did our Avito leads get linked to Yandex drivers
// after the sync-trips cron ran?
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  // Все наши Avito-лиды (avito_responses → crm_contact_id)
  const responses = await p.avito_responses.findMany({
    where: { crm_contact_id: { not: null } },
    select: { id: true, candidate_name: true, phone: true, crm_contact_id: true },
  })
  console.log(`Found ${responses.length} Avito responses with crm_contact_id`)
  for (const r of responses) {
    const c = await p.contact.findUnique({
      where: { id: r.crm_contact_id },
      select: {
        id: true,
        displayName: true,
        displayNameSource: true,
        yandexDriverId: true,
      },
    })
    let driver = null
    if (c?.yandexDriverId) {
      driver = await p.driver.findUnique({
        where: { yandexDriverId: c.yandexDriverId },
        select: { fullName: true, phone: true, dismissedAt: true, lastOrderAt: true },
      })
    }
    console.log(
      `avito-${r.id}  phone=${r.phone ?? '—'}  name="${r.candidate_name}"`,
    )
    console.log(
      `  contact: ${c?.displayName} (src=${c?.displayNameSource})  yandex=${c?.yandexDriverId ?? 'NONE'}`,
    )
    if (driver) {
      console.log(
        `  driver:  ${driver.fullName}  phone=${driver.phone}  dismissed=${driver.dismissedAt ? 'yes' : 'no'}  lastOrder=${driver.lastOrderAt?.toISOString() ?? 'never'}`,
      )
    }
  }
  await p.$disconnect()
})()
