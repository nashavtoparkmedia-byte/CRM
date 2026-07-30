'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildPlan,
  confirmationToken,
  safeReport,
  validateSnapshot,
} = require('./personal-max-live-history-backfill')

const snapshot = {
  schemaVersion: 1,
  source: 'max_provider_store_read_only',
  accountId: 'max-personal-test-account',
  protocolChatId: '900000000123',
  uiRouteId: '2351835259',
  providerChatId: '900000000123',
  routeMatchCount: 1,
  providerUserId: '900000000456',
  ownerUserId: '900000000789',
  profile: {
    phone: '+79990000011',
    phoneEvidence: {
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: true,
      providerIdentityId: '900000000456',
      protocolChatId: '900000000123',
      uiRouteId: '2351835259',
      observedAt: '2026-07-30T15:00:50.766Z',
    },
  },
  window: {
    start: '2026-07-30T06:20:00.000Z',
    end: '2026-07-30T14:40:00.000Z',
  },
  messages: [{
    providerMessageId: 'd30100000000000001',
    direction: 'outbound',
    providerUserId: '900000000789',
    timestamp: Date.parse('2026-07-30T06:26:36.000Z'),
    text: 'Точный текст 🧭',
    textDisposition: 'exact_unicode',
    messageType: 'text',
    attachmentCount: 0,
  }],
}

const canonicalContact = { id: 'contact-peer', primaryPhoneId: null, displayName: 'Эльдар' }
const protocolContact = { id: 'contact-protocol', primaryPhoneId: null, displayName: 'Эльдар' }
const uiContact = { id: 'contact-ui', primaryPhoneId: null, displayName: 'Эльдар' }
const canonicalChat = {
  id: 'chat-protocol',
  externalChatId: snapshot.protocolChatId,
  metadata: {},
}
const uiChat = {
  id: 'chat-ui',
  externalChatId: snapshot.uiRouteId,
  metadata: {},
}

function exactState() {
  return {
    identities: [
      { id: 'identity-peer', externalId: snapshot.providerUserId, contactId: canonicalContact.id, contact: canonicalContact, metadata: {} },
      { id: 'identity-protocol', externalId: snapshot.protocolChatId, contactId: protocolContact.id, contact: protocolContact, metadata: {} },
      { id: 'identity-ui', externalId: snapshot.uiRouteId, contactId: uiContact.id, contact: uiContact, metadata: {} },
    ],
    chats: [canonicalChat, uiChat],
    messages: [{
      id: 'dom-placeholder',
      chatId: uiChat.id,
      externalId: 'max-dom-evidence',
      direction: 'outbound',
      content: snapshot.messages[0].text,
      sentAt: new Date(snapshot.messages[0].timestamp + 5000),
      metadata: { source: 'max_web_mirror' },
    }],
    providerRows: [],
    dispatches: [],
    crmOriginated: [],
    phoneOwners: [],
    contactScopes: [
      { id: canonicalContact.id, identities: [], chats: [], phones: [] },
      {
        id: protocolContact.id,
        identities: [{ channel: 'max', externalId: snapshot.protocolChatId, isActive: true }],
        chats: [canonicalChat],
        phones: [],
      },
      {
        id: uiContact.id,
        identities: [{ channel: 'max', externalId: snapshot.uiRouteId, isActive: true }],
        chats: [uiChat],
        phones: [],
      },
    ],
  }
}

test('snapshot validation requires an exact provider-bound phone identity', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  assert.equal(bounds.normalizedPhone, '+79990000011')

  const uiRouteStoreSnapshot = structuredClone(snapshot)
  uiRouteStoreSnapshot.providerChatId = snapshot.uiRouteId
  assert.doesNotThrow(() => validateSnapshot(uiRouteStoreSnapshot, snapshot.accountId))

  const unrelatedStoreSnapshot = structuredClone(snapshot)
  unrelatedStoreSnapshot.providerChatId = '999999999'
  assert.throws(() => validateSnapshot(unrelatedStoreSnapshot, snapshot.accountId), /route binding is invalid/)

  const mismatched = structuredClone(snapshot)
  mismatched.profile.phoneEvidence.providerIdentityId = snapshot.protocolChatId
  assert.throws(() => validateSnapshot(mismatched, snapshot.accountId), /not exactly bound/)

  const stale = structuredClone(snapshot)
  stale.profile.phoneEvidence.observedAt = 'not-a-time'
  assert.throws(() => validateSnapshot(stale, snapshot.accountId), /not exactly bound/)
})

test('dry-run plan is exact-route scoped and includes no destructive deletion', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const plan = buildPlan(snapshot, bounds, exactState())
  assert.equal(plan.canonicalChat.id, canonicalChat.id)
  assert.equal(plan.canonicalContact.id, canonicalContact.id)
  assert.equal(plan.creates.length, 1)
  assert.equal(plan.suppressions.length, 1)
  assert.deepEqual(plan.supersededChats.map(chat => chat.id), [uiChat.id])
  assert.deepEqual(plan.mergeContacts.map(contact => contact.id).sort(), [protocolContact.id, uiContact.id].sort())

  const report = safeReport(snapshot, 'a'.repeat(64), plan, '/backup/marker')
  assert.equal(report.missingOwnAccountOutbound, 1)
  assert.equal(report.placeholderSuppressions, 1)
  assert.equal(report.mergedContacts, 2)
  assert.equal(report.confirmationToken, confirmationToken({
    snapshotSha: 'a'.repeat(64),
    accountId: snapshot.accountId,
    protocolChatId: snapshot.protocolChatId,
    canonicalChatId: canonicalChat.id,
    canonicalContactId: canonicalContact.id,
    backupMarker: '/backup/marker',
  }))
})

test('contact merge blocks any unrelated active identity, chat or phone', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  state.contactScopes[1].identities.push({ channel: 'telegram', externalId: 'unrelated', isActive: true })
  assert.throws(() => buildPlan(snapshot, bounds, state), /CONTACT_SCOPE_CONFLICT/)
})

test('one exact active phone owner becomes the survivor without creating a duplicate contact', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  const phoneContact = {
    id: 'contact-phone-owner',
    primaryPhoneId: 'phone-1',
    displayName: 'Existing driver',
    identities: [{ channel: 'telegram', externalId: 'tg-driver', isActive: true }],
    chats: [],
    phones: [{ id: 'phone-1', phone: bounds.normalizedPhone, isActive: true }],
  }
  state.phoneOwners = [{ id: 'phone-1', contactId: phoneContact.id }]
  state.contactScopes.push(phoneContact)

  const plan = buildPlan(snapshot, bounds, state)
  assert.equal(plan.canonicalContact.id, phoneContact.id)
  assert.deepEqual(
    plan.mergeContacts.map(contact => contact.id).sort(),
    [canonicalContact.id, protocolContact.id, uiContact.id].sort(),
  )
})

test('more than one active contact owning the exact phone fails closed', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  state.phoneOwners = [
    { id: 'phone-1', contactId: 'contact-phone-owner-1' },
    { id: 'phone-2', contactId: 'contact-phone-owner-2' },
  ]
  assert.throws(() => buildPlan(snapshot, bounds, state), /PHONE_OWNER_CONFLICT/)
})

test('phone owner bound to a different MAX identity fails closed', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  const phoneContact = {
    id: 'contact-phone-owner',
    identities: [{ channel: 'max', externalId: '900000009999', isActive: true }],
    chats: [],
    phones: [{ id: 'phone-1', phone: bounds.normalizedPhone, isActive: true }],
  }
  state.phoneOwners = [{ id: 'phone-1', contactId: phoneContact.id }]
  state.contactScopes.push(phoneContact)
  assert.throws(() => buildPlan(snapshot, bounds, state), /PHONE_OWNER_SCOPE_CONFLICT/)
})

test('provider row outside the two exact route chats blocks the backfill', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  state.providerRows.push({
    id: 'foreign-provider-row',
    chatId: 'foreign-chat',
    externalId: snapshot.messages[0].providerMessageId,
    content: snapshot.messages[0].text,
  })
  assert.throws(() => buildPlan(snapshot, bounds, state), /PROVIDER_ROW_SCOPE_CONFLICT/)
})

test('unresolved CRM dispatch is not projected as a second native bubble', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  state.dispatches.push({
    providerMessageId: snapshot.messages[0].providerMessageId,
    state: 'awaiting_confirmation',
    command: { clientMessageId: 'client-1' },
  })
  assert.throws(() => buildPlan(snapshot, bounds, state), /CRM_ECHO_RECONCILIATION_REQUIRED/)
})

test('empty provider event is quarantined without rendering a technical placeholder', () => {
  const emptySnapshot = structuredClone(snapshot)
  emptySnapshot.messages[0].text = ''
  const bounds = validateSnapshot(emptySnapshot, emptySnapshot.accountId)
  const state = exactState()
  state.messages = []
  state.providerRows = [{
    id: 'provider-empty-row',
    chatId: canonicalChat.id,
    externalId: emptySnapshot.messages[0].providerMessageId,
    content: '[Неподдерживаемое вложение MAX]',
    metadata: { origin: 'max_provider', source: 'history' },
  }]

  const plan = buildPlan(emptySnapshot, bounds, state)
  assert.equal(plan.creates.length, 0)
  assert.equal(plan.repairs.length, 0)
  assert.deepEqual(plan.quarantined, [emptySnapshot.messages[0].providerMessageId])
  assert.equal(plan.unsupportedEventSuppressions.length, 1)

  state.providerRows[0].metadata.personalMaxIngressDisposition = {
    kind: 'history_replay',
    visibility: 'quarantined',
    evidencePreserved: true,
    providerMessageId: emptySnapshot.messages[0].providerMessageId,
  }
  const secondPlan = buildPlan(emptySnapshot, bounds, state)
  assert.equal(secondPlan.unsupportedEventSuppressions.length, 0)
})

test('post-write state produces a zero-mutation idempotent plan', () => {
  const bounds = validateSnapshot(snapshot, snapshot.accountId)
  const state = exactState()
  state.identities = state.identities.map(identity => ({
    ...identity,
    contactId: canonicalContact.id,
    contact: canonicalContact,
  }))
  state.contactScopes = [{ id: canonicalContact.id, identities: [], chats: [], phones: [] }]
  state.chats[1] = {
    ...state.chats[1],
    metadata: {
      personalMaxProjection: { state: 'superseded', canonicalChatId: canonicalChat.id },
    },
  }
  state.messages[0].metadata = {
    source: 'max_web_mirror',
    personalMaxProjection: {
      visibility: 'suppressed_duplicate',
      evidencePreserved: true,
      canonicalProviderMessageId: snapshot.messages[0].providerMessageId,
    },
  }
  state.providerRows.push({
    id: 'provider-row',
    chatId: canonicalChat.id,
    externalId: snapshot.messages[0].providerMessageId,
    content: snapshot.messages[0].text,
  })

  const plan = buildPlan(snapshot, bounds, state)
  assert.equal(plan.creates.length, 0)
  assert.equal(plan.repairs.length, 0)
  assert.equal(plan.echoLinks.length, 0)
  assert.equal(plan.unsupportedEventSuppressions.length, 0)
  assert.equal(plan.suppressions.length, 0)
  assert.equal(plan.supersededChats.length, 0)
  assert.equal(plan.mergeContacts.length, 0)
  assert.deepEqual(plan.unchanged, [snapshot.messages[0].providerMessageId])
})
