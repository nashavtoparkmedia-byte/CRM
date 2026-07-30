#!/usr/bin/env node
'use strict'

const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { PrismaClient } = require('@prisma/client')

const PROVIDER_ID = /^d301[0-9a-f]{14}$/i
const DOM_SOURCES = new Set(['dom_fallback', 'live_dom_recovery', 'max_web_mirror'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeRussianPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length === 10) return `+7${digits}`
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) return `+7${digits.slice(1)}`
  return null
}

function parseArgs(argv) {
  const values = {}
  for (const arg of argv.slice(2)) {
    if (arg === '--write') values.write = true
    else if (arg.startsWith('--') && arg.includes('=')) {
      const split = arg.indexOf('=')
      values[arg.slice(2, split)] = arg.slice(split + 1)
    } else throw new Error(`Unsupported argument: ${arg}`)
  }
  if (!values.snapshot) throw new Error('--snapshot is required')
  if (!values['expected-snapshot-sha']) throw new Error('--expected-snapshot-sha is required')
  return values
}

function validateSnapshot(snapshot, expectedAccountId) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.source !== 'max_provider_store_read_only') {
    throw new Error('Snapshot schema/source is invalid')
  }
  if (snapshot.accountId !== expectedAccountId) throw new Error('Snapshot account mismatch')
  if (!/^\d{11,15}$/.test(snapshot.protocolChatId)
    || !/^\d{1,10}$/.test(snapshot.uiRouteId)
    || BigInt.asUintN(32, BigInt(snapshot.protocolChatId)).toString() !== snapshot.uiRouteId
    || ![snapshot.protocolChatId, snapshot.uiRouteId].includes(snapshot.providerChatId)
    || snapshot.routeMatchCount !== 1) throw new Error('Snapshot route binding is invalid')
  if (!/^\d{9,15}$/.test(snapshot.providerUserId)
    || !/^\d{9,15}$/.test(snapshot.ownerUserId)
    || snapshot.providerUserId === snapshot.ownerUserId) throw new Error('Snapshot participant binding is invalid')
  const start = new Date(snapshot.window?.start).getTime()
  const end = new Date(snapshot.window?.end).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Snapshot window is invalid')
  const ids = new Set()
  for (const message of snapshot.messages || []) {
    if (!PROVIDER_ID.test(message.providerMessageId) || ids.has(message.providerMessageId.toLowerCase())) {
      throw new Error('Snapshot provider message identity is invalid or duplicated')
    }
    ids.add(message.providerMessageId.toLowerCase())
    if (!['inbound', 'outbound'].includes(message.direction)
      || !Number.isFinite(Number(message.timestamp))
      || Number(message.timestamp) < start || Number(message.timestamp) > end) {
      throw new Error('Snapshot provider message bounds are invalid')
    }
    if (message.textDisposition === 'exact_unicode' && typeof message.text !== 'string') {
      throw new Error('Snapshot exact text is invalid')
    }
  }
  const normalizedPhone = normalizeRussianPhone(snapshot.profile?.phone)
  if (snapshot.profile?.phone && !normalizedPhone) throw new Error('Snapshot profile phone is invalid')
  const evidence = record(snapshot.profile?.phoneEvidence)
  const phoneObservedAt = new Date(evidence.observedAt).getTime()
  if (normalizedPhone && (
    evidence.sourceKind !== 'provider_profile'
    || evidence.trustedForAutomaticResolution !== true
    || String(evidence.providerIdentityId) !== snapshot.providerUserId
    || String(evidence.protocolChatId) !== snapshot.protocolChatId
    || String(evidence.uiRouteId) !== snapshot.uiRouteId
    || !Number.isFinite(phoneObservedAt)
  )) throw new Error('Snapshot profile phone is not exactly bound')
  return { start: new Date(start), end: new Date(end), normalizedPhone }
}

function confirmationToken(input) {
  return sha256([
    'personal-max-live-backfill-v1', input.snapshotSha, input.accountId,
    input.protocolChatId, input.canonicalChatId, input.canonicalContactId,
    input.backupMarker,
  ].join('\n'))
}

function metadataWith(base, patch) {
  return { ...record(base), ...patch }
}

async function collectState(prisma, snapshot, bounds) {
  const identityValues = [snapshot.providerUserId, snapshot.protocolChatId, snapshot.uiRouteId]
  const identities = await prisma.contactIdentity.findMany({
    where: { channel: 'max', externalId: { in: identityValues } },
    include: { contact: true },
  })
  const phoneOwners = bounds.normalizedPhone ? await prisma.contactPhone.findMany({
    where: { phone: bounds.normalizedPhone, isActive: true },
  }) : []
  const contactIds = [...new Set([
    ...identities.map(identity => identity.contactId),
    ...phoneOwners.map(phone => phone.contactId),
  ])]
  const chats = await prisma.chat.findMany({
    where: {
      channel: 'max',
      externalChatId: { in: [snapshot.protocolChatId, snapshot.uiRouteId] },
    },
  })
  const chatIds = chats.map(chat => chat.id)
  const messages = chatIds.length ? await prisma.message.findMany({
    where: {
      chatId: { in: chatIds },
      sentAt: {
        gte: new Date(bounds.start.getTime() - 60_000),
        lte: new Date(bounds.end.getTime() + 60_000),
      },
    },
    orderBy: [{ sentAt: 'asc' }, { externalId: 'asc' }, { id: 'asc' }],
  }) : []
  const providerIds = snapshot.messages.map(message => message.providerMessageId)
  const providerRows = providerIds.length ? await prisma.message.findMany({
    where: { externalId: { in: providerIds } },
  }) : []
  const dispatches = providerIds.length ? await prisma.maxOutboundDispatch.findMany({
    where: { accountId: snapshot.accountId, providerMessageId: { in: providerIds } },
    select: {
      providerMessageId: true,
      state: true,
      command: { select: { clientMessageId: true } },
    },
  }) : []
  const clientIds = dispatches.map(row => row.command.clientMessageId).filter(Boolean)
  const crmOriginated = clientIds.length ? await prisma.message.findMany({
    where: { clientMessageId: { in: clientIds } },
  }) : []
  const contactScopes = contactIds.length ? await prisma.contact.findMany({
    where: { id: { in: contactIds } },
    include: {
      identities: true,
      chats: { where: { channel: 'max' } },
      phones: { where: { isActive: true } },
    },
  }) : []
  return {
    identities,
    chats,
    messages,
    providerRows,
    dispatches,
    crmOriginated,
    phoneOwners,
    contactScopes,
  }
}

function buildPlan(snapshot, bounds, state) {
  const canonicalChat = state.chats.find(chat => chat.externalChatId === snapshot.protocolChatId)
  if (!canonicalChat) throw new Error('Canonical protocol chat is missing')
  const peerIdentities = state.identities.filter(identity => identity.externalId === snapshot.providerUserId)
  if (peerIdentities.length !== 1) throw new Error('Exact provider participant identity is missing or ambiguous')
  const canonicalIdentity = peerIdentities[0]
  const routeIdentityValues = new Set([snapshot.providerUserId, snapshot.protocolChatId, snapshot.uiRouteId])
  const routeChatValues = new Set([snapshot.protocolChatId, snapshot.uiRouteId])
  const phoneOwnerIds = [...new Set(state.phoneOwners.map(phone => phone.contactId))]
  if (phoneOwnerIds.length > 1) throw new Error('PHONE_OWNER_CONFLICT')
  const canonicalContact = phoneOwnerIds.length === 1
    ? state.contactScopes.find(contact => contact.id === phoneOwnerIds[0])
    : canonicalIdentity.contact
  if (!canonicalContact) throw new Error('PHONE_OWNER_SCOPE_MISSING')
  if (phoneOwnerIds.length === 1) {
    const unrelatedMaxIdentity = canonicalContact.identities.some(identity =>
      identity.isActive && identity.channel === 'max' && !routeIdentityValues.has(identity.externalId))
    const unrelatedMaxChat = canonicalContact.chats.some(chat => !routeChatValues.has(chat.externalChatId))
    if (unrelatedMaxIdentity || unrelatedMaxChat) throw new Error('PHONE_OWNER_SCOPE_CONFLICT')
  }

  const mergeContactIds = new Set(
    state.identities
      .filter(identity => identity.contactId !== canonicalContact.id)
      .map(identity => identity.contactId),
  )
  for (const contact of state.contactScopes) {
    if (!mergeContactIds.has(contact.id)) continue
    const unrelatedIdentity = contact.identities.some(identity =>
      identity.isActive && (identity.channel !== 'max' || !routeIdentityValues.has(identity.externalId)))
    const unrelatedChat = contact.chats.some(chat => !routeChatValues.has(chat.externalChatId))
    const unrelatedPhone = contact.phones.some(phone => phone.phone !== bounds.normalizedPhone)
    if (unrelatedIdentity || unrelatedChat || unrelatedPhone) {
      throw new Error('CONTACT_SCOPE_CONFLICT')
    }
  }

  const allowedChatIds = new Set(state.chats.map(chat => chat.id))
  if (state.providerRows.some(message => !allowedChatIds.has(message.chatId))) {
    throw new Error('PROVIDER_ROW_SCOPE_CONFLICT')
  }

  const existingByProviderId = new Map(
    state.providerRows.filter(message => message.externalId && PROVIDER_ID.test(message.externalId))
      .map(message => [message.externalId.toLowerCase(), message]),
  )
  const dispatchByProviderId = new Map(
    state.dispatches.filter(row => row.providerMessageId)
      .map(row => [row.providerMessageId.toLowerCase(), row]),
  )
  const crmByClientId = new Map(state.crmOriginated.filter(row => row.clientMessageId).map(row => [row.clientMessageId, row]))
  const creates = []
  const repairs = []
  const echoLinks = []
  const quarantined = []
  const unsupportedEventSuppressions = []
  const unchanged = []
  for (const provider of snapshot.messages) {
    const existing = existingByProviderId.get(provider.providerMessageId.toLowerCase())
    const unsupportedEmptyEvent = provider.text === '' && Number(provider.attachmentCount || 0) === 0
    if (provider.textDisposition === 'quarantined' || unsupportedEmptyEvent) {
      quarantined.push(provider.providerMessageId)
      if (unsupportedEmptyEvent && existing) {
        const disposition = record(record(existing.metadata).personalMaxIngressDisposition)
        if (!(disposition.kind === 'history_replay'
          && disposition.visibility === 'quarantined'
          && disposition.evidencePreserved === true
          && disposition.providerMessageId === provider.providerMessageId)) {
          unsupportedEventSuppressions.push({ existing, provider })
        }
      }
      continue
    }
    if (existing) {
      const repairText = provider.text !== null && existing.content !== provider.text
      const repairTimestamp = new Date(existing.sentAt).getTime() !== Number(provider.timestamp)
      const repairDirection = existing.direction !== provider.direction
      if (repairText || repairTimestamp || repairDirection) {
        repairs.push({ existing, provider, repairText, repairTimestamp, repairDirection })
      } else unchanged.push(provider.providerMessageId)
      continue
    }
    const dispatch = dispatchByProviderId.get(provider.providerMessageId.toLowerCase())
    const clientId = dispatch?.command.clientMessageId
    const crmMessage = clientId ? crmByClientId.get(clientId) : null
    if (provider.direction === 'outbound' && dispatch) {
      if (dispatch.state !== 'provider_confirmed' || !crmMessage) {
        throw new Error('CRM_ECHO_RECONCILIATION_REQUIRED')
      }
      echoLinks.push({ crmMessage, provider })
      continue
    }
    if (provider.text === null && Number(provider.attachmentCount || 0) === 0) {
      quarantined.push(provider.providerMessageId)
      continue
    }
    creates.push(provider)
  }

  const materializedProviderIds = new Set(snapshot.messages
    .filter(provider => provider.textDisposition !== 'quarantined'
      && ((provider.text !== null && provider.text !== '') || Number(provider.attachmentCount || 0) > 0))
    .map(message => message.providerMessageId.toLowerCase()))
  const suppressions = []
  for (const candidate of state.messages) {
    if (candidate.externalId && PROVIDER_ID.test(candidate.externalId)) continue
    const metadata = record(candidate.metadata)
    const projection = record(metadata.personalMaxProjection)
    if (projection.visibility === 'suppressed_duplicate'
      && projection.evidencePreserved === true
      && typeof projection.canonicalProviderMessageId === 'string') continue
    if (!DOM_SOURCES.has(String(metadata.source || ''))) continue
    const matches = snapshot.messages.filter(provider => {
      if (!materializedProviderIds.has(provider.providerMessageId.toLowerCase())) return false
      if (provider.text === null || provider.text !== candidate.content) return false
      if (provider.direction !== candidate.direction) return false
      return Math.abs(Number(provider.timestamp) - new Date(candidate.sentAt).getTime()) <= 15_000
    })
    if (matches.length === 1) {
      suppressions.push({ candidate, provider: matches[0] })
    }
  }

  const supersededChats = state.chats.filter(chat => {
    if (chat.id === canonicalChat.id || chat.externalChatId !== snapshot.uiRouteId) return false
    return record(record(chat.metadata).personalMaxProjection).state !== 'superseded'
  })
  const mergeContacts = [...new Map(
    state.identities
      .filter(identity => identity.contactId !== canonicalContact.id)
      .map(identity => [identity.contactId, identity.contact]),
  ).values()]
  return {
    canonicalChat,
    canonicalContact,
    canonicalIdentity,
    routeIdentities: state.identities,
    creates,
    repairs,
    echoLinks,
    quarantined,
    unsupportedEventSuppressions,
    unchanged,
    suppressions,
    supersededChats,
    mergeContacts,
    bounds,
  }
}

function safeReport(snapshot, snapshotSha, plan, backupMarker) {
  const token = confirmationToken({
    snapshotSha,
    accountId: snapshot.accountId,
    protocolChatId: snapshot.protocolChatId,
    canonicalChatId: plan.canonicalChat.id,
    canonicalContactId: plan.canonicalContact.id,
    backupMarker,
  })
  return {
    schemaVersion: 1,
    mode: 'dry_run',
    snapshotSha256: snapshotSha,
    accountId: snapshot.accountId,
    protocolChatId: snapshot.protocolChatId,
    uiRouteId: snapshot.uiRouteId,
    providerUserId: snapshot.providerUserId,
    canonicalChatId: plan.canonicalChat.id,
    canonicalContactId: plan.canonicalContact.id,
    providerMessages: snapshot.messages.length,
    missingOwnAccountOutbound: plan.creates.filter(message => message.direction === 'outbound').length,
    missingInbound: plan.creates.filter(message => message.direction === 'inbound').length,
    crmEchoLinks: plan.echoLinks.length,
    textRepairs: plan.repairs.filter(item => item.repairText).length,
    timelineRepairs: plan.repairs.filter(item => item.repairTimestamp || item.repairDirection).length,
    placeholderSuppressions: plan.suppressions.length,
    supersededChats: plan.supersededChats.length,
    mergedContacts: plan.mergeContacts.length,
    quarantined: plan.quarantined.length,
    unsupportedEventSuppressions: plan.unsupportedEventSuppressions.length,
    unchanged: plan.unchanged.length,
    phoneConflict: false,
    phonePresent: Boolean(plan.bounds.normalizedPhone),
    confirmationToken: token,
  }
}

async function applyPlan(prisma, snapshot, snapshotSha, plan) {
  const now = new Date()
  return prisma.$transaction(async tx => {
    let phone = null
    if (plan.bounds.normalizedPhone) {
      phone = await tx.contactPhone.upsert({
        where: {
          contactId_phone: {
            contactId: plan.canonicalContact.id,
            phone: plan.bounds.normalizedPhone,
          },
        },
        update: {
          isPrimary: true,
          isActive: true,
          source: 'max',
          verifiedAt: new Date(snapshot.profile.phoneEvidence.observedAt),
        },
        create: {
          contactId: plan.canonicalContact.id,
          phone: plan.bounds.normalizedPhone,
          source: 'max',
          isPrimary: true,
          isActive: true,
          verifiedAt: new Date(snapshot.profile.phoneEvidence.observedAt),
        },
      })
      if (plan.canonicalContact.primaryPhoneId !== phone.id) {
        await tx.contact.update({ where: { id: plan.canonicalContact.id }, data: { primaryPhoneId: phone.id } })
      }
    }

    for (const identity of plan.routeIdentities) {
      await tx.contactIdentity.update({
        where: { id: identity.id },
        data: {
          contactId: plan.canonicalContact.id,
          ...(phone ? { phoneId: phone.id } : {}),
          metadata: metadataWith(identity.metadata, {
            personalMaxIdentity: {
              version: 1,
              accountId: snapshot.accountId,
              protocolChatId: snapshot.protocolChatId,
              uiRouteId: snapshot.uiRouteId,
              providerUserId: snapshot.providerUserId,
              role: identity.externalId === snapshot.providerUserId
                ? 'provider_participant'
                : identity.externalId === snapshot.protocolChatId
                  ? 'protocol_chat'
                  : 'ui_route',
              snapshotSha256: snapshotSha,
            },
          }),
        },
      })
    }
    const canonicalIdentity = await tx.contactIdentity.findUnique({
      where: { channel_externalId: { channel: 'max', externalId: snapshot.providerUserId } },
    })
    if (!canonicalIdentity || canonicalIdentity.contactId !== plan.canonicalContact.id) {
      throw new Error('Canonical identity rebind failed')
    }

    const canonicalChatMetadata = metadataWith(plan.canonicalChat.metadata, {
      protocolChatId: snapshot.protocolChatId,
      uiRouteId: snapshot.uiRouteId,
      providerUserId: snapshot.providerUserId,
      providerAccountId: snapshot.accountId,
      phone: plan.bounds.normalizedPhone,
      phoneEvidence: snapshot.profile.phoneEvidence || null,
      personalMaxProjection: { state: 'canonical', repairedAt: now.toISOString(), snapshotSha256: snapshotSha },
    })
    await tx.chat.update({
      where: { id: plan.canonicalChat.id },
      data: {
        contactId: plan.canonicalContact.id,
        contactIdentityId: canonicalIdentity.id,
        metadata: canonicalChatMetadata,
      },
    })

    for (const chat of plan.supersededChats) {
      await tx.message.updateMany({ where: { chatId: chat.id }, data: { chatId: plan.canonicalChat.id } })
      await tx.chat.update({
        where: { id: chat.id },
        data: {
          contactId: plan.canonicalContact.id,
          contactIdentityId: canonicalIdentity.id,
          status: 'closed',
          chatType: 'superseded',
          unreadCount: 0,
          requiresResponse: false,
          metadata: metadataWith(chat.metadata, {
            personalMaxProjection: {
              state: 'superseded',
              canonicalChatId: plan.canonicalChat.id,
              evidencePreserved: true,
              snapshotSha256: snapshotSha,
            },
          }),
        },
      })
    }

    for (const contact of plan.mergeContacts) {
      const existingMerge = await tx.contactMerge.findFirst({
        where: { mergedId: contact.id, survivorId: plan.canonicalContact.id, action: 'merge' },
      })
      if (!existingMerge) {
        await tx.contactMerge.create({
          data: {
            survivorId: plan.canonicalContact.id,
            mergedId: contact.id,
            action: 'merge',
            mergedBy: 'personal-max-live-backfill-v1',
            reason: 'identity_match',
            confidence: 1,
            snapshotBefore: {
              displayName: contact.displayName,
              providerIdentityChain: [snapshot.providerUserId, snapshot.protocolChatId, snapshot.uiRouteId],
              snapshotSha256: snapshotSha,
            },
          },
        })
      }
      await tx.contact.update({ where: { id: contact.id }, data: { isArchived: true } })
    }

    for (const item of plan.echoLinks) {
      await tx.message.update({
        where: { id: item.crmMessage.id },
        data: {
          chatId: plan.canonicalChat.id,
          externalId: item.provider.providerMessageId,
          status: 'delivered',
          sentAt: new Date(item.provider.timestamp),
          metadata: metadataWith(item.crmMessage.metadata, {
            origin: 'crm',
            retryable: false,
            maxDelivery: {
              status: 'provider_confirmed',
              deliveryConfirmed: true,
              maxMessageId: item.provider.providerMessageId,
              externalId: item.provider.providerMessageId,
            },
          }),
        },
      })
    }

    for (const item of plan.repairs) {
      const beforeSha = sha256(item.existing.content)
      const afterSha = sha256(item.provider.text)
      const repairMetadata = {
        ...(item.repairText ? {
          personalMaxTextRepair: {
            version: 1,
            providerMessageId: item.provider.providerMessageId,
            beforeSha256: beforeSha,
            afterSha256: afterSha,
            snapshotSha256: snapshotSha,
            repairedAt: now.toISOString(),
          },
        } : {}),
        ...(item.repairTimestamp || item.repairDirection ? {
          personalMaxTimelineRepair: {
            version: 1,
            providerMessageId: item.provider.providerMessageId,
            timestampRepaired: item.repairTimestamp,
            directionRepaired: item.repairDirection,
            snapshotSha256: snapshotSha,
            repairedAt: now.toISOString(),
          },
        } : {}),
      }
      await tx.message.update({
        where: { id: item.existing.id },
        data: {
          chatId: plan.canonicalChat.id,
          ...(item.repairText ? { content: item.provider.text } : {}),
          direction: item.provider.direction,
          sentAt: new Date(item.provider.timestamp),
          metadata: metadataWith(item.existing.metadata, repairMetadata),
        },
      })
      for (const eventType of [
        ...(item.repairText ? ['personal_max_text_repaired'] : []),
        ...(item.repairTimestamp || item.repairDirection ? ['personal_max_timeline_repaired'] : []),
      ]) {
        const priorAudit = await tx.messageEventLog.findFirst({
          where: { messageId: item.existing.id, eventType },
        })
        if (!priorAudit) {
          await tx.messageEventLog.create({
            data: {
              messageId: item.existing.id,
              eventType,
              status: 'completed',
              metadata: eventType === 'personal_max_text_repaired'
                ? { beforeSha256: beforeSha, afterSha256: afterSha, snapshotSha256: snapshotSha }
                : {
                    timestampRepaired: item.repairTimestamp,
                    directionRepaired: item.repairDirection,
                    snapshotSha256: snapshotSha,
                  },
            },
          })
        }
      }
    }

    for (const item of plan.unsupportedEventSuppressions) {
      await tx.message.update({
        where: { id: item.existing.id },
        data: {
          chatId: plan.canonicalChat.id,
          metadata: metadataWith(item.existing.metadata, {
            personalMaxIngressDisposition: {
              kind: 'history_replay',
              visibility: 'quarantined',
              evidencePreserved: true,
              reason: 'empty_provider_event',
              providerMessageId: item.provider.providerMessageId,
              snapshotSha256: snapshotSha,
            },
          }),
        },
      })
    }

    for (const provider of plan.creates) {
      const existing = await tx.message.findUnique({ where: { externalId: provider.providerMessageId } })
      if (existing) continue
      const native = provider.direction === 'outbound'
      const created = await tx.message.create({
        data: {
          chatId: plan.canonicalChat.id,
          direction: provider.direction,
          type: provider.messageType === 'text' ? 'text' : 'system',
          content: provider.text || '[Неподдерживаемое вложение MAX]',
          channel: 'max',
          externalId: provider.providerMessageId,
          status: native ? 'sent' : 'delivered',
          sentAt: new Date(provider.timestamp),
          metadata: {
            origin: native ? 'max_native' : 'max_provider',
            source: 'history',
            retryable: false,
            providerUserId: provider.providerUserId,
            providerAccountId: snapshot.accountId,
            protocolChatId: snapshot.protocolChatId,
            uiRouteId: snapshot.uiRouteId,
            personalMaxHistory: { backfilled: true, liveNotification: false, snapshotSha256: snapshotSha },
            ...(native ? { maxDelivery: { status: 'provider_present', deliveryConfirmed: false, retryable: false } } : {}),
          },
        },
      })
      await tx.messageEventLog.create({
        data: {
          messageId: created.id,
          eventType: native ? 'personal_max_native_backfilled' : 'personal_max_inbound_backfilled',
          status: 'completed',
          metadata: { providerMessageId: provider.providerMessageId, snapshotSha256: snapshotSha },
        },
      })
    }

    for (const item of plan.suppressions) {
      await tx.message.update({
        where: { id: item.candidate.id },
        data: {
          chatId: plan.canonicalChat.id,
          metadata: metadataWith(item.candidate.metadata, {
            personalMaxProjection: {
              visibility: 'suppressed_duplicate',
              evidencePreserved: true,
              canonicalProviderMessageId: item.provider.providerMessageId,
              snapshotSha256: snapshotSha,
            },
          }),
        },
      })
    }

    const timeline = await tx.message.findMany({
      where: { chatId: plan.canonicalChat.id },
      select: { direction: true, sentAt: true, metadata: true },
      orderBy: [{ sentAt: 'asc' }],
    })
    const visible = timeline.filter(message => record(record(message.metadata).personalMaxProjection).visibility !== 'suppressed_duplicate')
    const last = visible.at(-1)?.sentAt || null
    const lastInbound = [...visible].reverse().find(message => message.direction === 'inbound')?.sentAt || null
    const lastOutbound = [...visible].reverse().find(message => message.direction === 'outbound')?.sentAt || null
    await tx.chat.update({
      where: { id: plan.canonicalChat.id },
      data: { lastMessageAt: last, lastInboundAt: lastInbound, lastOutboundAt: lastOutbound },
    })
    return {
      created: plan.creates.length,
      repaired: plan.repairs.length,
      echoLinked: plan.echoLinks.length,
      suppressed: plan.suppressions.length,
      unsupportedSuppressed: plan.unsupportedEventSuppressions.length,
      contactsMerged: plan.mergeContacts.length,
      chatsSuperseded: plan.supersededChats.length,
    }
  }, { timeout: 60_000 })
}

async function main() {
  const args = parseArgs(process.argv)
  const snapshotRaw = readFileSync(args.snapshot)
  const snapshotSha = sha256(snapshotRaw)
  if (snapshotSha !== args['expected-snapshot-sha']) throw new Error('Snapshot SHA-256 mismatch')
  const snapshot = JSON.parse(snapshotRaw.toString('utf8'))
  const accountId = process.env.MAX_PERSONAL_ACCOUNT_ID || ''
  if (!accountId) throw new Error('MAX_PERSONAL_ACCOUNT_ID is required')
  const bounds = validateSnapshot(snapshot, accountId)
  const prisma = new PrismaClient()
  try {
    const state = await collectState(prisma, snapshot, bounds)
    const plan = buildPlan(snapshot, bounds, state)
    const backupMarker = String(args['backup-marker'] || '')
    const report = safeReport(snapshot, snapshotSha, plan, backupMarker)
    if (!args.write) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }
    if (!backupMarker || !existsSync(backupMarker)) throw new Error('Exact backup marker is required for write')
    if (String(args['confirmation-token'] || '') !== report.confirmationToken) {
      throw new Error('Confirmation token mismatch')
    }
    const result = await applyPlan(prisma, snapshot, snapshotSha, plan)
    process.stdout.write(`${JSON.stringify({ ...report, mode: 'write', result }, null, 2)}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  buildPlan,
  confirmationToken,
  normalizeRussianPhone,
  parseArgs,
  safeReport,
  validateSnapshot,
}
