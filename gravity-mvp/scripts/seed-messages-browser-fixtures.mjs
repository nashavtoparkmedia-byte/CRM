import { PrismaClient } from '@prisma/client'

const databaseUrl = process.env.DATABASE_URL || ''
const fixtureMode = process.env.MESSAGES_BROWSER_FIXTURE_DB === '1'

function assertIsolatedDatabase() {
  if (!fixtureMode) {
    throw new Error('MESSAGES_BROWSER_FIXTURE_DB=1 is required')
  }
  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL must be a valid isolated PostgreSQL URL')
  }
  if (
    parsed.hostname !== 'codex-merge-test-postgres'
    || parsed.pathname !== '/crm_merge_test'
  ) {
    throw new Error(`Refusing fixture writes to ${parsed.hostname}${parsed.pathname}`)
  }
}

assertIsolatedDatabase()

const prisma = new PrismaClient()
const now = new Date()
const freshAt = new Date(now.getTime() - 5 * 60_000)
const staleSuccessAt = new Date(now.getTime() - 20 * 60_000)
const recentFailureAt = new Date(now.getTime() - 30_000)

const parks = [
  { id: 'browser-park-nash', code: 'NASH_AVTOPARK', name: 'Наш Автопарк', externalParkId: 'browser-ext-park-nash' },
  { id: 'browser-park-yoko', code: 'YOKO', name: 'YOKO', externalParkId: 'browser-ext-park-yoko' },
  { id: 'browser-park-yoko-2', code: 'YOKO_2', name: 'YOKO-2', externalParkId: 'browser-ext-park-yoko-2' },
  { id: 'browser-park-yoko-3', code: 'YOKO_3', name: 'YOKO-3', externalParkId: 'browser-ext-park-yoko-3' },
  { id: 'browser-park-yoko-4', code: 'YOKO_4', name: 'YOKO-4', externalParkId: 'browser-ext-park-yoko-4' },
  { id: 'browser-park-delivery', code: 'YOKO_DELIVERY', name: 'YOKO.Доставка', externalParkId: 'browser-ext-park-delivery' },
]

const ids = {
  remezov: 'browser-contact-remezov',
  shaburov: 'browser-contact-shaburov',
  addPhone: 'browser-contact-add-phone',
  otherOwner: 'browser-contact-other-owner',
  ambiguousOne: 'browser-contact-ambiguous-one',
  ambiguousTwo: 'browser-contact-ambiguous-two',
  sameNameOne: 'browser-contact-same-name-one',
  sameNameTwo: 'browser-contact-same-name-two',
  providerOnly: 'browser-contact-provider-only',
  mergeSource: 'browser-contact-merge-source',
  mergeTarget: 'browser-contact-merge-target',
  archivedSource: 'browser-contact-archived-source',
  canonicalTarget: 'browser-contact-canonical-target',
}

async function resetFixtures() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "DriverTelegram", "MessageAttachment", "Message", "Chat", "Call", "tasks", "ContactDriverProfileAudit", "ContactIdentity", "ContactPhone", "Driver", "ParkConnection", "ApiConnection", "Park", "ContactMerge", "Contact" CASCADE',
  )
}

async function createContact({ id, displayName, phone = null, archived = false }) {
  const contact = await prisma.contact.create({
    data: {
      id,
      displayName,
      displayNameSource: 'manual',
      masterSource: 'manual',
      isArchived: archived,
    },
  })
  if (!phone) return { contact, phone: null }

  const contactPhone = await prisma.contactPhone.create({
    data: {
      id: `${id}-phone`,
      contactId: id,
      phone,
      isPrimary: true,
      source: 'manual',
      verifiedAt: freshAt,
    },
  })
  await prisma.contact.update({
    where: { id },
    data: { primaryPhoneId: contactPhone.id },
  })
  return { contact, phone: contactPhone }
}

async function createChannel({
  contactId,
  phoneId = null,
  channel,
  externalId,
  chatId,
  displayName,
  metadata = {},
  content,
}) {
  const identity = await prisma.contactIdentity.create({
    data: {
      id: `${chatId}-identity`,
      contactId,
      channel,
      externalId,
      phoneId,
      displayName,
      source: 'manual',
      reachabilityStatus: 'confirmed',
      reachabilityCheckedAt: freshAt,
      metadata,
    },
  })
  const chat = await prisma.chat.create({
    data: {
      id: chatId,
      contactId,
      contactIdentityId: identity.id,
      channel,
      externalChatId: `${chatId}-external`,
      name: displayName,
      status: 'open',
      lastMessageAt: freshAt,
      lastInboundAt: freshAt,
    },
  })
  await prisma.message.create({
    data: {
      id: `${chatId}-message`,
      chatId,
      channel,
      direction: 'inbound',
      content,
      externalId: `${chatId}-message-external`,
      sentAt: freshAt,
    },
  })
  return { identity, chat }
}

async function createThreeChannels(contactId, phoneId, phoneDigits, name, slug, telegramId, username) {
  const max = await createChannel({
    contactId,
    phoneId,
    channel: 'max',
    externalId: `max-${slug}`,
    chatId: `browser-chat-${slug}-max`,
    displayName: name,
    metadata: {
      sourceKind: 'provider_contact',
      observedAt: freshAt.toISOString(),
      providerIdentity: `max-${slug}`,
      trustResult: 'trusted',
      resolutionResult: 'same_contact',
    },
    content: `Входящее MAX: ${name}`,
  })
  const telegram = await createChannel({
    contactId,
    phoneId,
    channel: 'telegram',
    externalId: telegramId,
    chatId: `browser-chat-${slug}-telegram`,
    displayName: name,
    metadata: {
      telegramUserId: telegramId,
      username,
      lastObservedUsername: `${username}_old`,
      usernameHistory: [{ username: `${username}_old`, observedAt: staleSuccessAt.toISOString() }],
      lastObservedAt: freshAt.toISOString(),
      lastSyncAt: freshAt.toISOString(),
    },
    content: `Входящее Telegram: ${name}`,
  })
  const whatsapp = await createChannel({
    contactId,
    phoneId,
    channel: 'whatsapp',
    externalId: `${phoneDigits}@c.us`,
    chatId: `browser-chat-${slug}-whatsapp`,
    displayName: name,
    metadata: { jid: `${phoneDigits}@c.us`, connectionStatus: 'connected' },
    content: `Входящее WhatsApp: ${name}`,
  })
  return { max, telegram, whatsapp }
}

async function createDriverProfile({ contactId, park, fullName, phone, slug }) {
  const connectionId = `browser-api-${park.code.toLowerCase()}`
  return prisma.driver.create({
    data: {
      id: `browser-driver-${slug}-${park.code.toLowerCase()}`,
      yandexDriverId: `browser-yandex-${slug}-${park.code.toLowerCase()}`,
      externalDriverProfileId: `${slug}-${park.code.toLowerCase()}-profile`,
      externalParkId: park.externalParkId,
      externalPersonKey: `phone:${phone}`,
      personKeyType: 'phone',
      personResolutionStatus: 'linked',
      personResolutionBasis: 'verified_phone',
      personResolutionAt: freshAt,
      personResolvedBy: 'browser-fixture',
      parkId: park.id,
      sourceConnectionId: connectionId,
      fullName,
      phone,
      lastExternalPark: park.name,
      lastFleetCheckAt: freshAt,
      lastFleetCheckStatus: 'working',
      hiredAt: new Date(now.getTime() - 120 * 24 * 60 * 60_000),
      segment: 'medium',
      contactId,
      customFields: {
        yandexProfile: {
          employmentType: 'self_employed',
          sourceWorkStatus: 'working',
          sourceCurrentStatus: 'working',
          sourceUpdatedAt: freshAt.toISOString(),
        },
      },
    },
  })
}

async function seedParks() {
  for (const [index, park] of parks.entries()) {
    const connectionId = `browser-api-${park.code.toLowerCase()}`
    await prisma.park.create({
      data: {
        id: park.id,
        parkCode: park.code,
        parkName: park.name,
        externalParkId: park.externalParkId,
      },
    })
    await prisma.apiConnection.create({
      data: {
        id: connectionId,
        clid: `browser-clid-${index + 1}`,
        apiKey: `browser-key-${index + 1}`,
        parkId: park.externalParkId,
        name: park.name,
      },
    })
    const isBackoffFixture = park.code === 'NASH_AVTOPARK'
    await prisma.parkConnection.create({
      data: {
        id: `browser-park-connection-${park.code.toLowerCase()}`,
        parkId: park.id,
        apiConnectionId: connectionId,
        externalParkId: park.externalParkId,
        lastSuccessfulSyncAt: isBackoffFixture ? staleSuccessAt : freshAt,
        lastFailedSyncAt: isBackoffFixture ? recentFailureAt : null,
        lastErrorSummary: isBackoffFixture
          ? 'Yandex API 429: {"code":"429","message":"Too many requests"}'
          : null,
      },
    })
  }
}

async function seedCanonicalContacts() {
  const remezov = await createContact({
    id: ids.remezov,
    displayName: 'Ремезов Александр Сергеевич',
    phone: '+79222155750',
  })
  await createThreeChannels(
    ids.remezov,
    remezov.phone.id,
    '79222155750',
    'Ремезов Александр Сергеевич',
    'remezov',
    '900000100001',
    'remezov_driver',
  )
  await prisma.contactIdentity.create({
    data: {
      id: 'browser-contact-remezov-max-phone-placeholder',
      contactId: ids.remezov,
      channel: 'max',
      externalId: '79222155750',
      phoneId: remezov.phone.id,
      source: 'auto',
      reachabilityStatus: 'confirmed',
      reachabilityCheckedAt: freshAt,
      metadata: { sourceKind: 'phone_reachability' },
    },
  })
  const remezovProfiles = []
  for (const park of parks) {
    remezovProfiles.push(await createDriverProfile({
      contactId: ids.remezov,
      park,
      fullName: 'Ремезов Александр Сергеевич',
      phone: '+79222155750',
      slug: 'remezov',
    }))
  }
  const remezovMain = remezovProfiles.find(profile => profile.parkId === 'browser-park-yoko')
  await prisma.contact.update({
    where: { id: ids.remezov },
    data: {
      mainDriverId: remezovMain.id,
      mainDriverSelection: 'manual',
      mainDriverSelectedBy: 'browser-fixture',
      mainDriverSelectedAt: freshAt,
    },
  })
  await prisma.driverTelegram.create({
    data: {
      id: 'browser-driver-telegram-remezov',
      driverId: remezovMain.id,
      telegramId: BigInt('900000100001'),
      username: 'remezov_driver',
      phoneVerified: true,
      activeParkId: parks[1].externalParkId,
    },
  })

  const shaburov = await createContact({
    id: ids.shaburov,
    displayName: 'Шабуров Евгений Анатольевич',
    phone: '+79126646745',
  })
  await createThreeChannels(
    ids.shaburov,
    shaburov.phone.id,
    '79126646745',
    'Шабуров Евгений Анатольевич',
    'shaburov',
    '900000100002',
    'shaburov_driver',
  )
  const shaburovMain = await createDriverProfile({
    contactId: ids.shaburov,
    park: parks[0],
    fullName: 'Шабуров Евгений Анатольевич',
    phone: '+79126646745',
    slug: 'shaburov',
  })
  await prisma.contact.update({
    where: { id: ids.shaburov },
    data: {
      mainDriverId: shaburovMain.id,
      mainDriverSelection: 'manual',
      mainDriverSelectedBy: 'browser-fixture',
      mainDriverSelectedAt: freshAt,
    },
  })
}

async function seedPhoneOwnershipCases() {
  const current = await createContact({
    id: ids.addPhone,
    displayName: 'Контакт проверки телефона',
    phone: '+79990000100',
  })
  await createChannel({
    contactId: ids.addPhone,
    phoneId: current.phone.id,
    channel: 'max',
    externalId: 'max-add-phone',
    chatId: 'browser-chat-add-phone-max',
    displayName: 'Контакт проверки телефона',
    content: 'Проверка добавления номера',
  })

  const other = await createContact({
    id: ids.otherOwner,
    displayName: 'Другой владелец номера',
    phone: '+79990000102',
  })
  await createChannel({
    contactId: ids.otherOwner,
    phoneId: other.phone.id,
    channel: 'telegram',
    externalId: '900000100102',
    chatId: 'browser-chat-other-owner',
    displayName: 'Другой владелец номера',
    content: 'Другой владелец',
  })

  for (const [id, name, suffix] of [
    [ids.ambiguousOne, 'Неоднозначный владелец Один', 'one'],
    [ids.ambiguousTwo, 'Неоднозначный владелец Два', 'two'],
  ]) {
    const owner = await createContact({ id, displayName: name, phone: '+79990000103' })
    await createChannel({
      contactId: id,
      phoneId: owner.phone.id,
      channel: 'max',
      externalId: `max-ambiguous-${suffix}`,
      chatId: `browser-chat-ambiguous-${suffix}`,
      displayName: name,
      content: `Неоднозначный ${suffix}`,
    })
  }
}

async function seedSearchAndProviderCases() {
  for (const [id, suffix] of [
    [ids.sameNameOne, 'one'],
    [ids.sameNameTwo, 'two'],
  ]) {
    const sameName = await createContact({
      id,
      displayName: 'Алексей Тестов',
      phone: suffix === 'one' ? '+79990000201' : '+79990000202',
    })
    await createChannel({
      contactId: id,
      phoneId: sameName.phone.id,
      channel: 'max',
      externalId: `max-same-name-${suffix}`,
      chatId: `browser-chat-same-name-${suffix}`,
      displayName: 'Алексей Тестов',
      content: `Однофамилец ${suffix}`,
    })
  }

  await createContact({
    id: ids.providerOnly,
    displayName: 'Неразрешённый MAX контакт',
  })
  await createChannel({
    contactId: ids.providerOnly,
    channel: 'max',
    externalId: 'max-provider-only',
    chatId: 'browser-chat-provider-only',
    displayName: 'Неразрешённый MAX контакт',
    metadata: { resolutionStatus: 'unresolved', sourceKind: 'provider_identity' },
    content: 'Provider-only входящее сообщение',
  })

  await createContact({
    id: ids.archivedSource,
    displayName: 'Старый provider-only контакт',
    archived: true,
  })
  const canonical = await createContact({
    id: ids.canonicalTarget,
    displayName: 'Канонический связанный контакт',
    phone: '+79990000250',
  })
  await createChannel({
    contactId: ids.canonicalTarget,
    phoneId: canonical.phone.id,
    channel: 'max',
    externalId: 'max-canonical-linked',
    chatId: 'browser-chat-canonical-linked',
    displayName: 'Канонический связанный контакт',
    content: 'Сохранённое сообщение после объединения',
  })
  await prisma.contactMerge.create({
    data: {
      id: 'browser-merge-archived-chain',
      survivorId: ids.canonicalTarget,
      mergedId: ids.archivedSource,
      action: 'merge',
      mergedBy: 'browser-fixture',
      reason: 'manual',
      snapshotBefore: { fixture: true },
    },
  })
}

async function seedMergeGraph() {
  const source = await createContact({
    id: ids.mergeSource,
    displayName: 'Источник browser merge',
    phone: '+79990000301',
  })
  await createContact({
    id: ids.mergeTarget,
    displayName: 'Цель browser merge',
    phone: '+79990000302',
  })
  const { identity, chat } = await createChannel({
    contactId: ids.mergeSource,
    phoneId: source.phone.id,
    channel: 'telegram',
    externalId: '900000100301',
    chatId: 'browser-chat-merge-source',
    displayName: 'Источник browser merge',
    metadata: { telegramUserId: '900000100301', username: 'merge_source' },
    content: 'Сообщение графа merge',
  })
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: `${chat.id}-message` },
  })
  await prisma.messageAttachment.create({
    data: {
      id: 'browser-merge-attachment',
      messageId: message.id,
      type: 'image',
      url: '/browser-fixture/image.jpg',
    },
  })
  await prisma.task.create({
    data: {
      id: 'browser-merge-task',
      contactId: ids.mergeSource,
      chatId: chat.id,
      type: 'follow_up',
      title: 'Browser merge task',
    },
  })
  await prisma.call.create({
    data: {
      id: 'browser-merge-call',
      contactId: ids.mergeSource,
      direction: 'inbound',
      fromNumber: '+79990000301',
      toNumber: '+79990000999',
      fsUuid: 'browser-merge-fs-uuid',
    },
  })
  const driver = await createDriverProfile({
    contactId: ids.mergeSource,
    park: parks[0],
    fullName: 'Источник browser merge',
    phone: '+79990000301',
    slug: 'merge-source',
  })
  await prisma.contact.update({
    where: { id: ids.mergeSource },
    data: { mainDriverId: driver.id, mainDriverSelection: 'manual' },
  })
  await prisma.contactDriverProfileAudit.create({
    data: {
      id: 'browser-merge-profile-audit',
      contactId: ids.mergeSource,
      driverId: driver.id,
      action: 'browser_fixture_attach',
      selectedBy: 'browser-fixture',
    },
  })
  await prisma.driverTelegram.create({
    data: {
      id: 'browser-merge-driver-telegram',
      driverId: driver.id,
      telegramId: BigInt('900000100301'),
      username: 'merge_source',
    },
  })
  return { identityId: identity.id }
}

async function main() {
  await resetFixtures()
  await seedParks()
  await seedCanonicalContacts()
  await seedPhoneOwnershipCases()
  await seedSearchAndProviderCases()
  const mergeGraph = await seedMergeGraph()

  const summary = {
    fixture: 'messages-browser',
    database: 'crm_merge_test',
    parks: parks.map(park => park.name),
    contacts: ids,
    chats: {
      remezov: 'browser-chat-remezov-max',
      shaburov: 'browser-chat-shaburov-max',
      addPhone: 'browser-chat-add-phone-max',
      providerOnly: 'browser-chat-provider-only',
      canonicalLinked: 'browser-chat-canonical-linked',
    },
    phones: {
      same: '+79990000100',
      free: '+79990000101',
      other: '+79990000102',
      ambiguous: '+79990000103',
    },
    mergeGraph,
  }
  console.log(JSON.stringify(summary, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
