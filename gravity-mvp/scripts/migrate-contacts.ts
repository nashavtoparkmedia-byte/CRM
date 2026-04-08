/**
 * Contact Model Migration Script
 *
 * Migrates existing Driver/DriverTelegram/DriverMax/Chat/Task data
 * into the new Contact/ContactPhone/ContactIdentity model.
 *
 * Usage:
 *   npx tsx scripts/migrate-contacts.ts --dry-run     # Report only, no writes
 *   npx tsx scripts/migrate-contacts.ts               # Execute migration
 *   npx tsx scripts/migrate-contacts.ts --verify      # Run verification only
 */

import { PrismaClient, ChatChannel } from '@prisma/client'

const prisma = new PrismaClient()

// ─── Config ─────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run')
const VERIFY_ONLY = process.argv.includes('--verify')
const BATCH_SIZE = 100

// ─── Phone normalization (duplicated from phoneUtils to keep script standalone) ─

function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return null

  let normalized: string
  if (digits.length === 11) {
    if (digits.startsWith('7') || digits.startsWith('8')) {
      normalized = '7' + digits.slice(1)
    } else {
      return null
    }
  } else if (digits.length === 10) {
    normalized = '7' + digits
  } else if (digits.length > 11) {
    normalized = '7' + digits.slice(-10)
  } else {
    return null
  }

  if (normalized.length !== 11 || !normalized.startsWith('7')) return null
  return '+' + normalized
}

function parseExternalChatId(externalChatId: string): { channel: string; externalId: string } {
  const colonIndex = externalChatId.indexOf(':')
  if (colonIndex === -1) {
    return { channel: 'max', externalId: externalChatId }
  }
  const channel = externalChatId.slice(0, colonIndex)
  const externalId = externalChatId.slice(colonIndex + 1)
  const known = ['whatsapp', 'telegram', 'max', 'yandex_pro']
  if (known.includes(channel)) {
    return { channel, externalId }
  }
  // Legacy MAX format: "max_name:ИМЯ"
  if (channel === 'max_name') {
    return { channel: 'max', externalId: `name_${externalId}` }
  }
  return { channel: 'unknown', externalId: externalChatId }
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

// ─── Stats tracking ─────────────────────────────────────────────────────────

const stats = {
  // Input counts
  totalDrivers: 0,
  totalDriverTelegram: 0,
  totalDriverMax: 0,
  totalChats: 0,
  totalTasks: 0,

  // Created counts
  contactsCreated: 0,
  contactsFromDrivers: 0,
  contactsFromChats: 0,
  phonesCreated: 0,
  identitiesCreated: 0,
  identitiesFromTelegram: 0,
  identitiesFromMax: 0,
  identitiesFromChats: 0,

  // Linked counts
  chatsLinked: 0,
  chatsWithoutContact: 0,
  tasksLinked: 0,

  // Issues
  duplicatePhones: [] as string[],
  errors: [] as string[],
  warnings: [] as string[],
}

function log(msg: string) {
  console.log(`[migrate] ${msg}`)
}

function warn(msg: string) {
  stats.warnings.push(msg)
  console.warn(`[migrate][WARN] ${msg}`)
}

function error(msg: string) {
  stats.errors.push(msg)
  console.error(`[migrate][ERROR] ${msg}`)
}

// ─── In-memory lookup maps (for dry run + perf) ────────────────────────────

// Maps to track what would be created in dry run
const contactByYandexId = new Map<string, string>()   // yandexDriverId → contactId
const contactByPhone = new Map<string, string>()       // phone E.164 → contactId
const identityByKey = new Map<string, string>()        // "channel:externalId" → contactId
const phonesByContact = new Map<string, Set<string>>() // contactId → Set of phones

let contactIdCounter = 0
function nextContactId(): string {
  return DRY_RUN ? `dry_contact_${++contactIdCounter}` : ''
}

// ─── Step 1: Driver → Contact ───────────────────────────────────────────────

async function step1_driversToContacts() {
  log('Step 1: Driver → Contact + ContactPhone')

  const drivers = await prisma.driver.findMany({
    select: {
      id: true,
      yandexDriverId: true,
      fullName: true,
      phone: true,
    },
  })

  stats.totalDrivers = drivers.length
  log(`  Found ${drivers.length} drivers`)

  for (let i = 0; i < drivers.length; i++) {
    const d = drivers[i]

    if (i > 0 && i % BATCH_SIZE === 0) {
      log(`  Progress: ${i}/${drivers.length}`)
    }

    const normalized = normalizePhoneE164(d.phone)

    if (DRY_RUN) {
      const cid = nextContactId()
      contactByYandexId.set(d.yandexDriverId, cid)
      if (normalized) {
        contactByPhone.set(normalized, cid)
        phonesByContact.set(cid, new Set([normalized]))
      }
      stats.contactsCreated++
      stats.contactsFromDrivers++
      if (normalized) stats.phonesCreated++
      continue
    }

    try {
      // Check if Contact already exists for this driver (idempotent)
      const existing = await prisma.contact.findUnique({
        where: { yandexDriverId: d.yandexDriverId },
      })
      if (existing) {
        contactByYandexId.set(d.yandexDriverId, existing.id)
        if (normalized) contactByPhone.set(normalized, existing.id)
        continue
      }

      const contact = await prisma.contact.create({
        data: {
          displayName: d.fullName,
          displayNameSource: d.yandexDriverId ? 'yandex' : 'channel',
          masterSource: d.yandexDriverId ? 'yandex' : 'chat',
          yandexDriverId: d.yandexDriverId,
        },
      })

      contactByYandexId.set(d.yandexDriverId, contact.id)
      stats.contactsCreated++
      stats.contactsFromDrivers++

      if (normalized) {
        // Check for existing phone on this contact
        const existingPhone = await prisma.contactPhone.findUnique({
          where: { contactId_phone: { contactId: contact.id, phone: normalized } },
        })

        if (!existingPhone) {
          const phone = await prisma.contactPhone.create({
            data: {
              contactId: contact.id,
              phone: normalized,
              source: 'yandex',
              isPrimary: true,
            },
          })

          await prisma.contact.update({
            where: { id: contact.id },
            data: { primaryPhoneId: phone.id },
          })

          stats.phonesCreated++
        }

        contactByPhone.set(normalized, contact.id)
      }
    } catch (e: any) {
      error(`Step1 driver=${d.id}: ${e.message}`)
    }
  }

  log(`  Done: ${stats.contactsFromDrivers} contacts, ${stats.phonesCreated} phones`)
}

// ─── Step 2: DriverTelegram → ContactIdentity ──────────────────────────────

async function step2_telegramIdentities() {
  log('Step 2: DriverTelegram → ContactIdentity')

  const records = await prisma.driverTelegram.findMany()

  stats.totalDriverTelegram = records.length
  log(`  Found ${records.length} DriverTelegram records`)

  for (const dt of records) {
    // DriverTelegram has no relation to Driver in schema — lookup manually
    const driver = await prisma.driver.findUnique({
      where: { id: dt.driverId },
      select: { yandexDriverId: true, phone: true },
    })
    if (!driver) {
      warn(`No Driver found for DriverTelegram driverId=${dt.driverId}`)
      continue
    }

    const contactId = contactByYandexId.get(driver.yandexDriverId)
    if (!contactId) {
      warn(`No Contact for DriverTelegram driverId=${dt.driverId}`)
      continue
    }

    const externalId = String(dt.telegramId)
    const key = `telegram:${externalId}`

    if (identityByKey.has(key)) continue // already processed

    // Find phoneId if driver has a phone
    let phoneId: string | null = null
    if (!DRY_RUN && driver.phone) {
      const normalized = normalizePhoneE164(driver.phone)
      if (normalized) {
        const phoneRecord = await prisma.contactPhone.findFirst({
          where: { contactId, phone: normalized },
        })
        phoneId = phoneRecord?.id || null
      }
    }

    if (DRY_RUN) {
      identityByKey.set(key, contactId)
      stats.identitiesCreated++
      stats.identitiesFromTelegram++
      continue
    }

    try {
      const existing = await prisma.contactIdentity.findUnique({
        where: { channel_externalId: { channel: 'telegram', externalId } },
      })
      if (existing) {
        identityByKey.set(key, existing.contactId)
        continue
      }

      await prisma.contactIdentity.create({
        data: {
          contactId,
          channel: 'telegram',
          externalId,
          phoneId,
          displayName: dt.username,
          source: 'auto',
          confidence: 1.0,
        },
      })

      identityByKey.set(key, contactId)
      stats.identitiesCreated++
      stats.identitiesFromTelegram++
    } catch (e: any) {
      error(`Step2 driverTelegram=${dt.id}: ${e.message}`)
    }
  }

  log(`  Done: ${stats.identitiesFromTelegram} telegram identities`)
}

// ─── Step 3: DriverMax → ContactIdentity ────────────────────────────────────

async function step3_maxIdentities() {
  log('Step 3: DriverMax → ContactIdentity')

  const records = await prisma.driverMax.findMany()

  stats.totalDriverMax = records.length
  log(`  Found ${records.length} DriverMax records`)

  for (const dm of records) {
    const driver = await prisma.driver.findUnique({
      where: { id: dm.driverId },
      select: { yandexDriverId: true, phone: true },
    })
    if (!driver) {
      warn(`No Driver found for DriverMax driverId=${dm.driverId}`)
      continue
    }

    const contactId = contactByYandexId.get(driver.yandexDriverId)
    if (!contactId) {
      warn(`No Contact for DriverMax driverId=${dm.driverId}`)
      continue
    }

    // Determine externalId: prefer maxExternalUserId, then maxExternalChatId, then phone
    const externalId = dm.maxExternalUserId || dm.maxExternalChatId || (dm.phone ? normalizePhoneE164(dm.phone)?.replace('+', '') : null)
    if (!externalId) {
      warn(`No externalId for DriverMax id=${dm.id}`)
      continue
    }

    const key = `max:${externalId}`
    if (identityByKey.has(key)) continue

    // If DriverMax has a separate phone, ensure ContactPhone exists
    let phoneId: string | null = null
    if (dm.phone) {
      const normalized = normalizePhoneE164(dm.phone)
      if (normalized && !DRY_RUN) {
        let phoneRecord = await prisma.contactPhone.findFirst({
          where: { contactId, phone: normalized },
        })
        if (!phoneRecord) {
          phoneRecord = await prisma.contactPhone.create({
            data: { contactId, phone: normalized, source: 'max', isPrimary: false },
          })
          stats.phonesCreated++
        }
        phoneId = phoneRecord.id
      }
      if (normalized && DRY_RUN) {
        if (!phonesByContact.get(contactId)?.has(normalized)) {
          stats.phonesCreated++
          phonesByContact.get(contactId)?.add(normalized)
        }
      }
    }

    if (DRY_RUN) {
      identityByKey.set(key, contactId)
      stats.identitiesCreated++
      stats.identitiesFromMax++
      continue
    }

    try {
      const existing = await prisma.contactIdentity.findUnique({
        where: { channel_externalId: { channel: 'max', externalId } },
      })
      if (existing) {
        identityByKey.set(key, existing.contactId)
        continue
      }

      await prisma.contactIdentity.create({
        data: {
          contactId,
          channel: 'max',
          externalId,
          phoneId,
          displayName: dm.name,
          source: 'auto',
          confidence: 1.0,
        },
      })

      identityByKey.set(key, contactId)
      stats.identitiesCreated++
      stats.identitiesFromMax++
    } catch (e: any) {
      error(`Step3 driverMax=${dm.id}: ${e.message}`)
    }
  }

  log(`  Done: ${stats.identitiesFromMax} max identities`)
}

// ─── Step 4: Chat → contactId + contactIdentityId ──────────────────────────

async function step4_linkChats() {
  log('Step 4: Chat → contactId + contactIdentityId')

  // In dry run, contactId column may not exist yet in DB — don't select it
  const chats = DRY_RUN
    ? await prisma.chat.findMany({
        select: {
          id: true,
          driverId: true,
          channel: true,
          externalChatId: true,
          name: true,
        },
      }).then(rows => rows.map(r => ({ ...r, contactId: null as string | null, contactIdentityId: null as string | null })))
    : await prisma.chat.findMany({
        select: {
          id: true,
          driverId: true,
          channel: true,
          externalChatId: true,
          name: true,
          contactId: true,
          contactIdentityId: true,
        },
      })

  stats.totalChats = chats.length
  log(`  Found ${chats.length} chats`)

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]

    if (i > 0 && i % BATCH_SIZE === 0) {
      log(`  Progress: ${i}/${chats.length}`)
    }

    // Skip fully migrated (has both contactId and contactIdentityId)
    if (!DRY_RUN && chat.contactId && chat.contactIdentityId) {
      stats.chatsLinked++
      continue
    }

    const parsed = parseExternalChatId(chat.externalChatId)
    let contactId: string | null = null
    let identityContactId: string | null = null

    // Attempt 1: via driverId → Contact
    if (chat.driverId) {
      const driver = await prisma.driver.findUnique({
        where: { id: chat.driverId },
        select: { yandexDriverId: true },
      })
      if (driver) {
        contactId = contactByYandexId.get(driver.yandexDriverId) || null
      }
    }

    // Attempt 2: via externalId → ContactIdentity
    if (!contactId) {
      const key = `${parsed.channel}:${parsed.externalId}`
      identityContactId = identityByKey.get(key) || null
      if (identityContactId) contactId = identityContactId
    }

    // Attempt 3: via phone in externalId
    if (!contactId && looksLikePhone(parsed.externalId)) {
      const normalized = normalizePhoneE164(parsed.externalId)
      if (normalized) {
        contactId = contactByPhone.get(normalized) || null

        // Also try DB lookup for phones created in earlier steps
        if (!contactId && !DRY_RUN) {
          const phoneRecord = await prisma.contactPhone.findFirst({
            where: { phone: normalized, isActive: true },
            select: { contactId: true },
          })
          if (phoneRecord) contactId = phoneRecord.contactId
        }
      }
    }

    // Attempt 4: create new Contact
    if (!contactId) {
      const displayName = chat.name || parsed.externalId

      if (DRY_RUN) {
        const cid = nextContactId()
        contactId = cid
        stats.contactsCreated++
        stats.contactsFromChats++

        if (looksLikePhone(parsed.externalId)) {
          const normalized = normalizePhoneE164(parsed.externalId)
          if (normalized) {
            contactByPhone.set(normalized, cid)
            stats.phonesCreated++
          }
        }
      } else {
        try {
          const contact = await prisma.contact.create({
            data: {
              displayName,
              displayNameSource: 'channel',
              masterSource: 'chat',
            },
          })
          contactId = contact.id
          stats.contactsCreated++
          stats.contactsFromChats++

          if (looksLikePhone(parsed.externalId)) {
            const normalized = normalizePhoneE164(parsed.externalId)
            if (normalized) {
              const existingPhone = await prisma.contactPhone.findFirst({
                where: { phone: normalized },
              })
              if (!existingPhone) {
                const phone = await prisma.contactPhone.create({
                  data: {
                    contactId: contact.id,
                    phone: normalized,
                    source: parsed.channel as any || 'manual',
                    isPrimary: true,
                  },
                })
                await prisma.contact.update({
                  where: { id: contact.id },
                  data: { primaryPhoneId: phone.id },
                })
                stats.phonesCreated++
              }
              contactByPhone.set(normalized, contact.id)
            }
          }
        } catch (e: any) {
          error(`Step4 chat=${chat.id} create contact: ${e.message}`)
          stats.chatsWithoutContact++
          continue
        }
      }
    }

    // Ensure ContactIdentity exists for this chat
    const identityKey = `${parsed.channel}:${parsed.externalId}`
    let identityId: string | null = null

    if (!identityByKey.has(identityKey) && contactId) {
      if (DRY_RUN) {
        identityByKey.set(identityKey, contactId)
        stats.identitiesCreated++
        stats.identitiesFromChats++
      } else {
        try {
          const channelEnum = parsed.channel as ChatChannel
          const validChannels: string[] = ['telegram', 'whatsapp', 'max', 'yandex_pro']
          if (!validChannels.includes(parsed.channel)) {
            warn(`Unknown channel "${parsed.channel}" for chat=${chat.id}`)
          } else {
            const existing = await prisma.contactIdentity.findUnique({
              where: { channel_externalId: { channel: channelEnum, externalId: parsed.externalId } },
            })

            if (existing) {
              identityId = existing.id
              identityByKey.set(identityKey, existing.contactId)
            } else {
              // Find phoneId
              let phoneId: string | null = null
              if (looksLikePhone(parsed.externalId)) {
                const normalized = normalizePhoneE164(parsed.externalId)
                if (normalized) {
                  const phoneRecord = await prisma.contactPhone.findFirst({
                    where: { contactId, phone: normalized },
                  })
                  phoneId = phoneRecord?.id || null
                }
              }

              const identity = await prisma.contactIdentity.create({
                data: {
                  contactId,
                  channel: channelEnum,
                  externalId: parsed.externalId,
                  phoneId,
                  source: 'auto',
                  confidence: 1.0,
                },
              })
              identityId = identity.id
              identityByKey.set(identityKey, contactId)
              stats.identitiesCreated++
              stats.identitiesFromChats++
            }
          }
        } catch (e: any) {
          // Unique constraint violation = identity already exists (race or re-run)
          if (e.code === 'P2002') {
            const existing = await prisma.contactIdentity.findUnique({
              where: { channel_externalId: { channel: parsed.channel as ChatChannel, externalId: parsed.externalId } },
            })
            identityId = existing?.id || null
          } else {
            error(`Step4 chat=${chat.id} create identity: ${e.message}`)
          }
        }
      }
    } else if (!DRY_RUN) {
      // Identity already exists, get its id
      const existing = await prisma.contactIdentity.findUnique({
        where: { channel_externalId: { channel: parsed.channel as ChatChannel, externalId: parsed.externalId } },
      })
      identityId = existing?.id || null
    }

    // Update Chat
    if (!DRY_RUN && contactId) {
      try {
        await prisma.chat.update({
          where: { id: chat.id },
          data: {
            contactId,
            contactIdentityId: identityId,
          },
        })
        stats.chatsLinked++
      } catch (e: any) {
        error(`Step4 chat=${chat.id} update: ${e.message}`)
        stats.chatsWithoutContact++
      }
    } else if (DRY_RUN && contactId) {
      stats.chatsLinked++
    } else {
      stats.chatsWithoutContact++
    }
  }

  log(`  Done: ${stats.chatsLinked} linked, ${stats.chatsWithoutContact} without contact`)
}

// ─── Step 5: Task → contactId ───────────────────────────────────────────────

async function step5_linkTasks() {
  log('Step 5: Task → contactId')

  const tasks = DRY_RUN
    ? await prisma.task.findMany({
        select: {
          id: true,
          driverId: true,
          driver: { select: { yandexDriverId: true } },
        },
      }).then(rows => rows.map(r => ({ ...r, contactId: null as string | null })))
    : await prisma.task.findMany({
        select: {
          id: true,
          driverId: true,
          contactId: true,
          driver: { select: { yandexDriverId: true } },
        },
      })

  stats.totalTasks = tasks.length
  log(`  Found ${tasks.length} tasks with driverId`)

  for (const task of tasks) {
    if (!DRY_RUN && task.contactId) {
      stats.tasksLinked++
      continue
    }

    const contactId = contactByYandexId.get(task.driver.yandexDriverId)
    if (!contactId) {
      warn(`No Contact for Task id=${task.id}, driverId=${task.driverId}`)
      continue
    }

    if (DRY_RUN) {
      stats.tasksLinked++
      continue
    }

    try {
      await prisma.task.update({
        where: { id: task.id },
        data: { contactId },
      })
      stats.tasksLinked++
    } catch (e: any) {
      error(`Step5 task=${task.id}: ${e.message}`)
    }
  }

  log(`  Done: ${stats.tasksLinked} tasks linked`)
}

// ─── Step 6: Detect duplicate phones ────────────────────────────────────────

async function step6_detectDuplicates() {
  log('Step 6: Detecting duplicate phones across contacts')

  if (DRY_RUN) {
    // Build from in-memory maps
    const phoneToContacts = new Map<string, string[]>()
    for (const [phone, contactId] of contactByPhone) {
      const arr = phoneToContacts.get(phone) || []
      arr.push(contactId)
      phoneToContacts.set(phone, arr)
    }
    // In dry run, phone→contact is 1:1 by construction, so no dups detectable
    log('  (dry run: cross-contact dups cannot be detected without DB)')
    return
  }

  const result = await prisma.$queryRaw<Array<{ phone: string; cnt: bigint }>>`
    SELECT phone, COUNT(DISTINCT "contactId") as cnt
    FROM "ContactPhone"
    WHERE "isActive" = true
    GROUP BY phone
    HAVING COUNT(DISTINCT "contactId") > 1
  `

  for (const row of result) {
    const msg = `Phone ${row.phone} belongs to ${row.cnt} contacts`
    stats.duplicatePhones.push(row.phone)
    warn(msg)
  }

  log(`  Done: ${stats.duplicatePhones.length} duplicate phones detected`)
}

// ─── Verification ───────────────────────────────────────────────────────────

async function verify() {
  log('=== VERIFICATION ===')

  // 1. Chats without contactId
  const chatsNoContact = await prisma.chat.count({ where: { contactId: null } })
  const totalChats = await prisma.chat.count()
  log(`  Chats without contactId: ${chatsNoContact} / ${totalChats} (${((1 - chatsNoContact / totalChats) * 100).toFixed(1)}% linked)`)

  // 2. Contacts with yandexDriverId but no matching Driver
  const orphanContacts = await prisma.$queryRaw<Array<{ cnt: bigint }>>`
    SELECT COUNT(*) as cnt FROM "Contact"
    WHERE "yandexDriverId" IS NOT NULL
    AND "yandexDriverId" NOT IN (SELECT "yandexDriverId" FROM "Driver")
  `
  log(`  Orphan contacts (yandexDriverId not in Driver): ${orphanContacts[0]?.cnt || 0}`)

  // 3. Duplicate identities
  const dupIdentities = await prisma.$queryRaw<Array<{ cnt: bigint }>>`
    SELECT COUNT(*) as cnt FROM (
      SELECT channel, "externalId"
      FROM "ContactIdentity"
      GROUP BY channel, "externalId"
      HAVING COUNT(*) > 1
    ) t
  `
  log(`  Duplicate identities (channel+externalId): ${dupIdentities[0]?.cnt || 0}`)

  // 4. Chats with contactId but no contactIdentityId
  const chatsNoIdentity = await prisma.chat.count({
    where: { contactId: { not: null }, contactIdentityId: null },
  })
  log(`  Chats with contactId but no identityId: ${chatsNoIdentity}`)

  // 5. Contact(yandex) count vs Driver count
  const contactYandex = await prisma.contact.count({ where: { masterSource: 'yandex' } })
  const driverCount = await prisma.driver.count()
  log(`  Contacts(masterSource=yandex): ${contactYandex}, Drivers: ${driverCount}`)

  // 6. Totals
  const contactCount = await prisma.contact.count()
  const phoneCount = await prisma.contactPhone.count()
  const identityCount = await prisma.contactIdentity.count()
  log(`  Total contacts: ${contactCount}`)
  log(`  Total phones: ${phoneCount}`)
  log(`  Total identities: ${identityCount}`)

  // 7. Duplicate phones
  const dupPhones = await prisma.$queryRaw<Array<{ phone: string; cnt: bigint }>>`
    SELECT phone, COUNT(DISTINCT "contactId") as cnt
    FROM "ContactPhone"
    WHERE "isActive" = true
    GROUP BY phone
    HAVING COUNT(DISTINCT "contactId") > 1
  `
  log(`  Duplicate phones (cross-contact): ${dupPhones.length}`)
  for (const dp of dupPhones) {
    log(`    ${dp.phone} → ${dp.cnt} contacts`)
  }

  const allGood =
    chatsNoContact === 0 &&
    Number(orphanContacts[0]?.cnt || 0) === 0 &&
    Number(dupIdentities[0]?.cnt || 0) === 0 &&
    chatsNoIdentity === 0

  log(`\n  RESULT: ${allGood ? '✅ ALL CHECKS PASSED' : '⚠️  ISSUES DETECTED'}`)
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printReport() {
  console.log('\n' + '='.repeat(60))
  console.log(DRY_RUN ? '  DRY RUN REPORT' : '  MIGRATION REPORT')
  console.log('='.repeat(60))
  console.log(`
  Input:
    Drivers:          ${stats.totalDrivers}
    DriverTelegram:   ${stats.totalDriverTelegram}
    DriverMax:        ${stats.totalDriverMax}
    Chats:            ${stats.totalChats}
    Tasks:            ${stats.totalTasks}

  Created:
    Contacts:         ${stats.contactsCreated}
      from Drivers:   ${stats.contactsFromDrivers}
      from Chats:     ${stats.contactsFromChats}
    Phones:           ${stats.phonesCreated}
    Identities:       ${stats.identitiesCreated}
      from Telegram:  ${stats.identitiesFromTelegram}
      from MAX:       ${stats.identitiesFromMax}
      from Chats:     ${stats.identitiesFromChats}

  Linked:
    Chats:            ${stats.chatsLinked} / ${stats.totalChats}
    Chats unlinked:   ${stats.chatsWithoutContact}
    Tasks:            ${stats.tasksLinked} / ${stats.totalTasks}

  Issues:
    Duplicate phones: ${stats.duplicatePhones.length}
    Warnings:         ${stats.warnings.length}
    Errors:           ${stats.errors.length}
  `)

  if (stats.errors.length > 0) {
    console.log('  ERRORS:')
    for (const e of stats.errors.slice(0, 20)) {
      console.log(`    ${e}`)
    }
    if (stats.errors.length > 20) {
      console.log(`    ... and ${stats.errors.length - 20} more`)
    }
  }

  if (stats.warnings.length > 0 && stats.warnings.length <= 20) {
    console.log('  WARNINGS:')
    for (const w of stats.warnings) {
      console.log(`    ${w}`)
    }
  } else if (stats.warnings.length > 20) {
    console.log(`  WARNINGS: ${stats.warnings.length} total (showing first 10)`)
    for (const w of stats.warnings.slice(0, 10)) {
      console.log(`    ${w}`)
    }
  }

  console.log('='.repeat(60))
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting migration ${DRY_RUN ? '(DRY RUN)' : '(EXECUTE)'} ${VERIFY_ONLY ? '(VERIFY ONLY)' : ''}`)

  if (VERIFY_ONLY) {
    await verify()
    return
  }

  const startTime = Date.now()

  await step1_driversToContacts()
  await step2_telegramIdentities()
  await step3_maxIdentities()
  await step4_linkChats()
  await step5_linkTasks()
  await step6_detectDuplicates()

  printReport()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log(`Completed in ${elapsed}s`)

  if (!DRY_RUN) {
    log('\nRunning verification...')
    await verify()
  }
}

main()
  .catch((e) => {
    console.error('Migration failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
