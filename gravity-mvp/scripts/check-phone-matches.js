// Are there ANY phones shared between ContactPhone and Driver?
// If yes — matcher should have linked them. If no — matcher just had
// nothing to do (which is fine, our 8 Avito leads aren't real drivers).
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  // Take a sample of 100 active ContactPhone numbers, see how many
  // appear in Driver.phone.
  const contactPhones = await p.contactPhone.findMany({
    where: { isActive: true },
    select: { phone: true, contactId: true },
    take: 1000,
  })
  console.log(`Sampling ${contactPhones.length} active ContactPhone rows`)

  const phones = [...new Set(contactPhones.map((x) => x.phone))]
  const matchedDrivers = await p.driver.findMany({
    where: { phone: { in: phones } },
    select: { yandexDriverId: true, phone: true, dismissedAt: true, fullName: true },
  })
  console.log(`Driver rows matching those phones: ${matchedDrivers.length}`)

  // Of those matched drivers, how many of their Contacts have yandexDriverId set?
  const phonesWithMatch = [...new Set(matchedDrivers.map((d) => d.phone))]
  let withLink = 0
  let withoutLink = 0
  for (const phone of phonesWithMatch) {
    const cp = await p.contactPhone.findFirst({
      where: { phone, isActive: true },
      include: {
        contact: { select: { id: true, displayName: true, yandexDriverId: true } },
      },
    })
    if (cp?.contact?.yandexDriverId) withLink++
    else withoutLink++
  }
  console.log(`Of ${phonesWithMatch.length} matched phones:`)
  console.log(`  ${withLink} contact(s) ALREADY linked to a yandex driver ✓`)
  console.log(`  ${withoutLink} contact(s) still UNLINKED ✗`)

  // If any unlinked — show first 3 as samples
  if (withoutLink > 0) {
    console.log(`\nFirst 3 unlinked samples (matcher should have caught these):`)
    let shown = 0
    for (const phone of phonesWithMatch) {
      if (shown >= 3) break
      const cp = await p.contactPhone.findFirst({
        where: { phone, isActive: true },
        include: {
          contact: { select: { id: true, displayName: true, yandexDriverId: true } },
        },
      })
      if (!cp?.contact?.yandexDriverId) {
        const drivers = await p.driver.findMany({
          where: { phone },
          select: { yandexDriverId: true, fullName: true, dismissedAt: true, lastOrderAt: true },
        })
        console.log(
          `  phone=${phone}  contact="${cp?.contact?.displayName}"  drivers=${drivers.length}`,
        )
        for (const d of drivers) {
          console.log(
            `    → ${d.yandexDriverId.slice(0, 12)}  "${d.fullName}"  dismissed=${d.dismissedAt ? 'yes' : 'no'}  lastOrder=${d.lastOrderAt?.toISOString() ?? 'never'}`,
          )
        }
        shown++
      }
    }
  }
  await p.$disconnect()
})()
